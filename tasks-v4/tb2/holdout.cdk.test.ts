/** harness-bench holdout (tb2/cdk): TTL attribute renamed in infrastructure. */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { TelosStack } from '../lib/telos-stack.js';

function template(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return Template.fromStack(new TelosStack(app, 'TelosStack', { env: { account: '123456789012', region: 'us-east-1' } }));
}

describe('holdout tb2: CDK time-to-live attribute', () => {
  it('no table declares ttl as its TTL attribute', () => {
    const tables = template().findResources('AWS::DynamoDB::Table');
    const specs = Object.values(tables)
      .map((t) => (t as { Properties: Record<string, { AttributeName?: string; Enabled?: boolean }> }).Properties['TimeToLiveSpecification'])
      .filter(Boolean);
    expect(specs.length).toBeGreaterThanOrEqual(2);
    for (const s of specs) {
      expect(s?.AttributeName).toBe('expiresAt');
      expect(s?.Enabled).toBe(true);
    }
  });
});
