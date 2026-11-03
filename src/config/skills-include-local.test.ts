import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { createAgents } from '../agents';
import { createFilterAvailableSkillsHook } from '../hooks/filter-available-skills';
import { discoverProjectLocalSkillNames } from './project-skills';
import { RuntimeConfig } from './runtime';
import { PluginConfigSchema } from './schema';

const tempDirs: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mechanicus-local-skills-'),
  );
  tempDirs.push(projectDir);
  return projectDir;
}

function writeSkill(
  projectDir: string,
  relativeDir: string,
  name: string,
  source: '.opencode' | '.agents' = '.opencode',
): void {
  const skillDir = path.join(projectDir, source, 'skills', relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} project skill\n---\n\n# ${name}\n`,
  );
}

function availableSkillsBlock(...names: string[]): string {
  return `<available_skills>\n${names
    .map(
      (name) =>
        `<skill>\n  <name>${name}</name>\n  <description>${name}</description>\n  <location>file:///tmp/${name}</location>\n</skill>`,
    )
    .join('\n')}\n</available_skills>`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    RuntimeConfig.reset(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverProjectLocalSkillNames', () => {
  test('discovers nested skills by frontmatter name and ignores invalid files', () => {
    const projectDir = makeProject();
    writeSkill(
      projectDir,
      'folder-name-does-not-matter',
      'project-architecture',
    );
    writeSkill(projectDir, 'nested/testing', 'project-testing');
    const invalidDir = path.join(projectDir, '.opencode', 'skills', 'invalid');
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(
      path.join(invalidDir, 'SKILL.md'),
      '# missing frontmatter name',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([
      'project-architecture',
      'project-testing',
    ]);
  });

  test('returns an empty list when the project has no local skills directory', () => {
    expect(discoverProjectLocalSkillNames(makeProject())).toEqual([]);
  });

  test('combines both local roots with sorted, deduplicated frontmatter names', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'legacy', 'project-shared');
    writeSkill(projectDir, 'duplicate', 'project-shared', '.agents');
    writeSkill(projectDir, 'nested/new', 'agents-only', '.agents');

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([
      'agents-only',
      'project-shared',
    ]);
  });

  test('discovers .agents skills when .opencode is absent', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'only', 'agents-only', '.agents');

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual(['agents-only']);
  });

  test.each(['.opencode', '.agents'] as const)(
    'ignores an external %s root while retaining the other local root',
    (source) => {
      const projectDir = makeProject();
      const externalDir = makeProject();
      const other = source === '.agents' ? '.opencode' : '.agents';
      writeSkill(externalDir, 'external', 'external-skill', source);
      writeSkill(projectDir, 'local', 'local-skill', other);
      fs.symlinkSync(
        path.join(externalDir, source),
        path.join(projectDir, source),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(discoverProjectLocalSkillNames(projectDir)).toEqual([
        'local-skill',
      ]);
    },
  );

  test('does not follow symlinked skills or inherit ancestor skills', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'ancestor', 'ancestor-skill', '.agents');
    const child = path.join(projectDir, 'child');
    writeSkill(child, 'local', 'local-skill', '.agents');
    fs.symlinkSync(
      path.join(projectDir, '.agents', 'skills', 'ancestor'),
      path.join(child, '.agents', 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(discoverProjectLocalSkillNames(child)).toEqual(['local-skill']);
  });

  test('does not follow a project skills root that resolves outside the project', () => {
    const projectDir = makeProject();
    const externalDir = makeProject();
    const externalSkillsRoot = path.join(externalDir, 'shared-skills');
    const externalSkillDir = path.join(externalSkillsRoot, 'external-skill');
    fs.mkdirSync(externalSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(externalSkillDir, 'SKILL.md'),
      '---\nname: external-skill\ndescription: external\n---\n',
    );

    const opencodeDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.symlinkSync(
      externalSkillsRoot,
      path.join(opencodeDir, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([]);
  });
});

describe('skills_include_local', () => {
  test('includes .agents skills only when opted in and removal still wins', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'local', 'local-agents', '.agents');
    writeSkill(projectDir, 'removed', 'removed-agents', '.agents');
    RuntimeConfig.init(
      projectDir,
      PluginConfigSchema.parse({
        agents: {
          dominus: {
            skills_include_local: true,
            skills_remove: ['removed-agents'],
          },
          magos: { skills: [] },
        },
      }),
    );
    const runtime = RuntimeConfig.get(projectDir);
    expect(runtime.agent('dominus')?.skills).toContain('local-agents');
    expect(runtime.agent('dominus')?.skills).not.toContain('removed-agents');
    expect(runtime.agent('magos')?.skills).not.toContain('local-agents');
  });

  test('adds all project .opencode/skills entries to an agent effective skills', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-architecture', 'project-architecture');
    writeSkill(projectDir, 'nested/project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills: ['codemap'],
          skills_include_local: true,
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const runtime = RuntimeConfig.get(projectDir);
    const oracle = createAgents(runtime, { projectDirectory: projectDir }).find(
      (agent) => agent.name === 'dominus',
    );
    const skillPermissions = oracle?.config.permission?.skill as
      | Record<string, string>
      | undefined;

    expect(skillPermissions?.codemap).toBe('allow');
    expect(skillPermissions?.['project-architecture']).toBe('allow');
    expect(skillPermissions?.['project-testing']).toBe('allow');
  });

  test('skills_remove still wins over an automatically included local skill', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-architecture', 'project-architecture');
    writeSkill(projectDir, 'project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills_include_local: true,
          skills_remove: ['project-testing'],
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const effective = RuntimeConfig.get(projectDir).agents().dominus?.skills;

    expect(effective).toContain('project-architecture');
    expect(effective).not.toContain('project-testing');
  });

  test('preserves local-skill grants from a legacy alias across canonical config layers', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      preset: 'local-project',
      presets: {
        'local-project': {
          explore: {
            skills_include_local: true,
          },
        },
      },
      agents: {
        explorer: {
          skills: ['codemap'],
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const effective = RuntimeConfig.get(projectDir).agent('explorer')?.skills;

    expect(effective).toContain('codemap');
    expect(effective).toContain('project-testing');
  });

  test('available-skills filtering keeps automatically included local skills', async () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills: ['codemap'],
          skills_include_local: true,
        },
      },
    });
    RuntimeConfig.init(projectDir, config);
    const runtime = RuntimeConfig.get(projectDir);
    const hook = createFilterAvailableSkillsHook({} as PluginInput, runtime);
    const output = {
      messages: [
        {
          info: { role: 'system' },
          parts: [
            {
              type: 'text',
              text: availableSkillsBlock(
                'codemap',
                'project-testing',
                'unrelated-global-skill',
              ),
            },
          ],
        },
        {
          info: { role: 'user', agent: 'oracle' },
          parts: [{ type: 'text', text: 'check skills' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    const result = output.messages[0].parts[0].text;
    expect(result).toContain('<name>codemap</name>');
    expect(result).toContain('<name>project-testing</name>');
    expect(result).not.toContain('<name>unrelated-global-skill</name>');
  });
});
