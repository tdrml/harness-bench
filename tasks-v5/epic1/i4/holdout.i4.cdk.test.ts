/**
 * harness-bench pilot 7 holdout - epic1 / i4 (infrastructure half, brief item 8).
 *
 * A separate file from the lambdas holdout because vitest's four projects are
 * package-rooted and the CDK stack cannot be imported from `packages/lambdas`
 * (it would also break `tsc --build`'s rootDir for that package).
 *
 * The synth setup — bundling disabled, SSM lookups pre-seeded via context — is
 * copied verbatim from `packages/cdk/src/__tests__/auto-graph-stack.test.ts`;
 * without it, synth tries to bundle the Lambda assets.
 *
 * INVARIANCE NOTE: the task-definition count is asserted as a lower bound, not
 * an exact count. Issue 6 adds a tenth task definition, so `resourceCountIs(…, 9)`
 * would be true only for the window between i4 and i6. i6's holdout pins the
 * exact end-of-epic count.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AutoGraphStack } from '../stacks/auto-graph-stack.js';

describe('holdout i4: packager ECS task definition', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App({
      context: {
        'aws:cdk:bundling-stacks': [],
        'ssm:account=123456789012:parameterName=/asdlc/vpc-id:region=us-east-1': 'vpc-test123',
        'ssm:account=123456789012:parameterName=/asdlc/private-subnet-ids:region=us-east-1':
          'subnet-priv1,subnet-priv2',
      },
    });
    const stack = new AutoGraphStack(app, 'HoldoutI4Stack', {
      prefix: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  it('creates a Fargate task definition for the packager with the pinned family and size', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'test-packager',
      Cpu: '2048',
      Memory: '8192',
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
    });
  });

  it('adds the packager on top of the existing eight task definitions', () => {
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    expect(Object.keys(taskDefs).length).toBeGreaterThanOrEqual(9);
  });
});
