/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('MODEL_MAPPINGS includes supported providers', () => {
    const keys = Object.keys(MODEL_MAPPINGS);
    expect(keys.sort()).toEqual([
      'copilot',
      'kimi',
      'openai',
      'opencode-go',
      'zai-plan',
    ]);
  });

  test('generateLiteConfig defaults to openai and includes generated presets', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    expect(config.$schema).toBe(
      'https://raw.githubusercontent.com/shyrz/mechanicus/master/mechanicus.schema.json',
    );
    expect(config.preset).toBe('openai');
    expect(config.disabled_agents).toBeUndefined();
    expect((config.presets as any)['opencode-go']).toBeDefined();
    expect((config.presets as any)['opencode-go'].observer.model).toBe(
      'opencode-go/mimo-v2.5',
    );
    const agents = (config.presets as any).openai;
    expect(agents).toBeDefined();
    expect(agents.omnissiah.model).toBe('openai/gpt-5.6-terra');
    expect(agents.omnissiah.variant).toBe('high');
    expect(agents.genetor.model).toBe('openai/gpt-5.6-luna');
    expect(agents.genetor.variant).toBe('high');
  });

  test('preserves exact OpenAI model and variant mappings', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    const expected = {
      omnissiah: { model: 'openai/gpt-5.6-terra', variant: 'high' },
      dominus: { model: 'openai/gpt-5.6-sol', variant: 'high' },
      logis: { model: 'openai/gpt-5.6-luna', variant: 'low' },
      magos: { model: 'openai/gpt-5.6-luna', variant: 'low' },
      artisan: { model: 'openai/gpt-5.6-luna', variant: 'medium' },
      genetor: { model: 'openai/gpt-5.6-luna', variant: 'high' },
    } as const;

    expect(MODEL_MAPPINGS.openai).toEqual(expected);
    expect(agents).toMatchObject(expected);
  });

  test('generateLiteConfig can set opencode-go as active preset', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      preset: 'opencode-go',
      backgroundSubagents: 'no',
      reset: false,
    });

    expect(config.preset).toBe('opencode-go');
    expect(config.disabled_agents).toEqual([]);
    expect((config.presets as any).openai).toBeDefined();
    const agents = (config.presets as any)['opencode-go'];
    expect(agents).toBeDefined();
    expect(agents.omnissiah.model).toBe('opencode-go/minimax-m3');
    expect(agents.omnissiah.variant).toBe('thinking');
    expect(agents.dominus.model).toBe('opencode-go/qwen3.7-max');
    expect(agents.dominus.variant).toBe('max');
    expect(agents.council).toBeUndefined();
    expect(agents.logis.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.logis.variant).toBe('high');
    expect(agents.logis.mcps).toEqual(['context7', 'gh_grep']);
    expect(agents.magos.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.magos.variant).toBe('high');
    expect(agents.artisan.model).toBe('opencode-go/kimi-k2.7-code');
    expect(agents.artisan.variant).toBeUndefined();
    expect(agents.genetor.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.genetor.variant).toBe('high');
    expect(agents.observer.model).toBe('opencode-go/mimo-v2.5');
    expect(agents.observer.variant).toBeUndefined();
  });

  test('generateLiteConfig rejects unsupported preset', () => {
    expect(() =>
      generateLiteConfig({
        installCustomSkills: false,
        preset: 'not-real',
        backgroundSubagents: 'no',
        reset: false,
      }),
    ).toThrow('Unsupported preset "not-real"');
  });

  test('generateLiteConfig rejects non-generated model mappings as active presets', () => {
    expect(() =>
      generateLiteConfig({
        installCustomSkills: false,
        preset: 'kimi',
        backgroundSubagents: 'no',
        reset: false,
      }),
    ).toThrow('Unsupported preset "kimi"');
  });

  test('generateLiteConfig rejects inherited property names as presets', () => {
    expect(() =>
      generateLiteConfig({
        installCustomSkills: false,
        preset: 'toString',
        backgroundSubagents: 'no',
        reset: false,
      }),
    ).toThrow('Unsupported preset "toString"');
  });

  test('generateLiteConfig companion: yes', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
      companion: 'yes',
    });

    expect(config.companion).toBeDefined();
    expect((config.companion as any).enabled).toBe(true);
    expect((config.companion as any).position).toBe('bottom-right');
    expect((config.companion as any).size).toBe('medium');
  });

  test('generateLiteConfig companion: no or omitted', () => {
    const configYes = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
      companion: 'no',
    });
    expect(configYes.companion).toBeUndefined();

    const configOmitted = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });
    expect(configOmitted.companion).toBeUndefined();
  });

  test('generateLiteConfig includes default skills', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    // Orchestrator should always have '*'
    expect(agents.omnissiah.skills).toEqual(['*']);

    // Oracle should have bundled simplify
    expect(agents.dominus.skills).toContain('simplify');

    // Orchestrator should implicitly cover bundled codemap via '*'
    expect(agents.omnissiah.skills).toContain('*');

    // Designer should have no bundled skills by default
    expect(agents.artisan.skills).toEqual([]);

    // Explorer should have no bundled skills by default
    expect(agents.magos.skills).toEqual([]);

    // Fixer should have no bundled skills by default
    expect(agents.genetor.skills).toEqual([]);
  });

  test('generateLiteConfig includes mcps field', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.omnissiah.mcps).toBeDefined();
    expect(Array.isArray(agents.omnissiah.mcps)).toBe(true);
    expect(agents.logis.mcps).toBeDefined();
    expect(Array.isArray(agents.logis.mcps)).toBe(true);
  });

  test('generateLiteConfig openai includes correct mcps', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.omnissiah.mcps).toEqual(['*', '!context7']);
    expect(agents.logis.mcps).toContain('context7');
    expect(agents.logis.mcps).toContain('gh_grep');
    expect(agents.artisan.mcps).toEqual([]);
  });
});
