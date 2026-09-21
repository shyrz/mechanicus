/**
 * A custom skill bundled in this repository.
 * Unlike npx-installed skills, these are copied from src/skills/ to the OpenCode skills directory
 */
export interface CustomSkill {
  /** Skill name (folder name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** List of agents that should auto-allow this skill */
  allowedAgents: string[];
  /** Source path in this repo (relative to project root) */
  sourcePath: string;
}

/**
 * Registry of custom skills bundled in this repository.
 */
export const CUSTOM_SKILLS: CustomSkill[] = [
  {
    name: 'simplify',
    description: 'Code simplification and readability-focused refactoring',
    allowedAgents: ['dominus'],
    sourcePath: 'src/skills/simplify',
  },
  {
    name: 'codemap',
    description: 'Repository understanding and hierarchical codemap generation',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/codemap',
  },
  {
    name: 'clonedeps',
    description: 'Clone important dependency source for local inspection',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/clonedeps',
  },
  {
    name: 'deepwork',
    description:
      'Heavy/complex coding sessions and large modifications workflow',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/deepwork',
  },
  {
    name: 'verification-planning',
    description:
      'Plan credible, proportionate evidence before non-trivial implementation',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/verification-planning',
  },
  {
    name: 'reflect',
    description:
      'Review repeated work and suggest reusable workflow improvements',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/reflect',
  },
  {
    name: 'mechanicus',
    description: 'Configure, customize, and safely improve mechanicus setups',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/mechanicus',
  },
  {
    name: 'worktrees',
    description:
      'Manage Git worktrees as Mechanicus safe isolated coding lanes for complex/risky/parallel work',
    allowedAgents: ['omnissiah'],
    sourcePath: 'src/skills/worktrees',
  },
];
