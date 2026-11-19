const memberName = (node) => (node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : null) : node.property.name);

const unwrap = (node) => (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression' ? unwrap(node.expression) : node);

const isTestObject = (node) => node.type === 'Identifier' && node.name === 'test'
  || node.type === 'MemberExpression' && isTestObject(node.object);

export default {
  meta: { name: 'kimi-e2e' },
  rules: {
    'user-visible-only': {
      meta: {
        type: 'problem',
        messages: {
          expectedFailure: 'Do not mark e2e tests as expected failures with test.{{name}}; assert what the user sees now or delete the check.',
          webSocket: 'Do not route or read the app server WebSocket in e2e specs; assert what the user sees.',
          appGlobal: 'Do not read app globals through window.{{name}} in e2e specs; assert what the user sees.',
        },
      },
      create(context) {
        return {
          MemberExpression(node) {
            const name = memberName(node);
            if (name === null) return;
            if ((name === 'fail' || name === 'fixme') && isTestObject(node.object)) {
              context.report({ node, messageId: 'expectedFailure', data: { name } });
            } else if (name === 'routeWebSocket') {
              context.report({ node, messageId: 'webSocket' });
            } else if (name.startsWith('__') && unwrap(node.object).type === 'Identifier' && unwrap(node.object).name === 'window') {
              context.report({ node, messageId: 'appGlobal', data: { name } });
            }
          },
        };
      },
    },
  },
};
