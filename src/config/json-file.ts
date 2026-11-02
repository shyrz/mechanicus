import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  SyntaxKind,
} from 'jsonc-parser';
import { z } from 'zod';
import { resolveConfigWritePath } from '../cli/write-path';

const JsonConfigSchema = z.record(z.string(), z.unknown());
type JsonConfig = z.infer<typeof JsonConfigSchema>;

/** Reject ambiguous duplicate keys before applying path-based edits. */
export function parseJsonConfigText(source: string): JsonConfig {
  const text = source.replace(/^\uFEFF/, '');
  const errors: Parameters<typeof parseTree>[1] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !root) throw new Error('Invalid JSONC config');
  if (root.type !== 'object') {
    throw new Error('Config file must contain a JSON object');
  }
  const checkKeys = (node: NonNullable<typeof root>): void => {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (keys.has(key)) throw new Error('Duplicate JSONC config property');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) checkKeys(child);
  };
  checkKeys(root);
  const parsed: unknown = JSON.parse(JSON.stringify(getNodeValue(root)));
  JsonConfigSchema.parse(parsed);
  // Keep every own key. Zod's defensive record copy omits __proto__, but a
  // local edit must preserve unrelated user bytes and values at that key.
  return parsed as JsonConfig;
}

function isRecord(value: unknown): value is JsonConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeProperty(source: string, path: string[]): string {
  const root = parseTree(source);
  const value = root && findNodeAtLocation(root, path);
  const property = value?.parent;
  const object = property?.parent;
  if (!property || !object)
    throw new Error('JSONC property to remove was not found');
  const properties = object.children ?? [];
  const index = properties.indexOf(property);
  const previous = properties[index - 1];
  const next = properties[index + 1];
  const scanner = createScanner(source);
  scanner.setPosition(
    previous ? previous.offset + previous.length : object.offset + 1,
  );
  const commas: Array<{ offset: number; length: number }> = [];
  while (
    scanner.getPosition() < (next?.offset ?? object.offset + object.length - 1)
  ) {
    if (scanner.scan() === SyntaxKind.EOF) break;
    if (scanner.getToken() === SyntaxKind.CommaToken) {
      commas.push({
        offset: scanner.getTokenOffset(),
        length: scanner.getTokenLength(),
      });
    }
  }
  const after = commas.find(
    (comma) => comma.offset >= property.offset + property.length,
  );
  const before = commas.find((comma) => comma.offset < property.offset);
  const removals = [{ offset: property.offset, length: property.length }];
  if (after) removals.push(after);
  else if (before) removals.push(before);
  return applyEdits(
    source,
    removals.map((edit) => ({ ...edit, content: '' })),
  );
}

/** Edit individual fields so unrelated JSONC bytes and comments survive. */
export function mutateJsonConfigText(
  source: string,
  mutate: (config: JsonConfig) => JsonConfig,
): string {
  const original = parseJsonConfigText(source);
  const updated = mutate(structuredClone(original));
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = source.slice(bom.length);
  const indentation = text.match(/(?:^|\r?\n)([ \t]+)"/)?.[1] ?? '  ';
  const formattingOptions = {
    insertSpaces: !indentation.includes('\t'),
    tabSize: indentation.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
  const edit = (before: unknown, after: unknown, path: string[]): void => {
    if (isDeepStrictEqual(before, after)) return;
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        edit(
          Object.hasOwn(before, key) ? before[key] : undefined,
          Object.hasOwn(after, key) ? after[key] : undefined,
          [...path, key],
        );
      }
      return;
    }
    text =
      after === undefined
        ? removeProperty(text, path)
        : applyEdits(text, modify(text, path, after, { formattingOptions }));
  };
  edit(original, updated, []);
  const content = `${bom}${text}`;
  if (!isDeepStrictEqual(parseJsonConfigText(content), updated)) {
    throw new Error('JSONC edit did not preserve the requested config');
  }
  return content;
}

/** Publish an existing config atomically, retaining symlinks and file mode. */
export function mutateJsonConfigFile(
  file: string,
  mutate: (config: JsonConfig) => JsonConfig,
): void {
  const target = resolveConfigWritePath(file);
  const original = readFileSync(target, 'utf8');
  const content = mutateJsonConfigText(original, mutate);
  if (content === original) return;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const mode = statSync(target).mode & 0o777;
  try {
    const fd = openSync(temporary, 'wx', mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (
      resolveConfigWritePath(file) !== target ||
      readFileSync(target, 'utf8') !== original
    ) {
      throw new Error(
        'Config changed while saving; reopen the editor and retry',
      );
    }
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A failed temporary-file cleanup must not hide the original write error.
    }
  }
}
