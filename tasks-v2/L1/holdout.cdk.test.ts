/** harness-bench holdout (L1/cdk): telos-documenter infra. */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { TelosStack } from '../lib/telos-stack.js';

function buildTemplate(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TelosStack(app, 'TelosStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('holdout L1: documenter task definition', () => {
  it('creates telos-documenter at 1 vCPU / 4096 MB', () => {
    buildTemplate().hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'telos-documenter',
      Cpu: '1024',
      Memory: '4096',
    });
  });

  it('creates the documenter log group', () => {
    buildTemplate().hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/telos/ecs/documenter',
    });
  });

  it('now has 7 ECS task definitions', () => {
    buildTemplate().resourceCountIs('AWS::ECS::TaskDefinition', 7);
  });
});
