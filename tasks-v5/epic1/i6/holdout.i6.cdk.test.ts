/**
 * harness-bench pilot 7 holdout - epic1 / i6 (infrastructure half, brief item 9).
 *
 * Separate file for the same reason as i4's CDK holdout: vitest's projects are
 * package-rooted and `packages/cdk` cannot be reached from `packages/lambdas`.
 *
 * The synth setup is copied verbatim from
 * `packages/cdk/src/__tests__/auto-graph-stack.test.ts` — without the
 * bundling-disabled context, synth tries to bundle the Lambda assets.
 *
 * The exact task-definition count IS asserted here (unlike i4's lower bound):
 * the marketer is the tenth and last one this epic adds, so ten is the
 * end-of-epic truth. The brief also requires existing count assertions be
 * updated, which makes the count gradeable.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AutoGraphStack } from '../stacks/auto-graph-stack.js';

describe('holdout i6: marketer ECS task definition', () => {
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
    const stack = new AutoGraphStack(app, 'HoldoutI6Stack', {
      prefix: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  it('creates a Fargate task definition for the marketer with the pinned family and size', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'test-marketer',
      Cpu: '2048',
      Memory: '8192',
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
    });
  });

  it('still creates the packager task definition added earlier in this epic', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'test-packager',
      Cpu: '2048',
      Memory: '8192',
    });
  });

  it('creates exactly ten Fargate task definitions', () => {
    template.resourceCountIs('AWS::ECS::TaskDefinition', 10);
  });
});
