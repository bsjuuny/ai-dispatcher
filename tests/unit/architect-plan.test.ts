import { describe, expect, it } from 'vitest';
import { parseArchitectPlan } from '../../src/harness/plan.js';

describe('parseArchitectPlan', () => {
  it('extracts a fenced structured plan and validates its DAG', () => {
    const plan = parseArchitectPlan(`Result:\n\`\`\`json\n${JSON.stringify({
      summary: 'Implement API and UI',
      risks: ['integration'],
      testStrategy: ['unit', 'integration'],
      tasks: [
        { id: 'T1', title: 'API', description: 'Build API', dependencies: [], worker: 'codex', files: ['src/api.ts'], risk: 'medium' },
        { id: 'T2', title: 'UI', description: 'Build UI', dependencies: ['T1'], worker: 'codex', files: ['src/ui.ts'], risk: 'low' },
      ],
    })}\n\`\`\``);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]?.dependencies).toEqual(['T1']);
  });

  it('rejects prose without JSON', () => {
    expect(() => parseArchitectPlan('I would make three changes.')).toThrow(/JSON object/);
  });
});
