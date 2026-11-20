const memberName = (node) => node.computed
  ? node.property.type === 'Literal' ? String(node.property.value) : null
  : node.property.name;

const propertyName = (node) => node.computed
  ? node.key.type === 'Literal' ? String(node.key.value) : null
  : node.key.name ?? node.key.value;

const unwrap = (node) => node.type === 'TSAsExpression'
  || node.type === 'TSNonNullExpression'
  || node.type === 'TSTypeAssertion'
  || node.type === 'ParenthesizedExpression'
  ? unwrap(node.expression)
  : node;

const isGlobalObject = (node) => {
  const target = unwrap(node);
  return target.type === 'Identifier' && (target.name === 'globalThis' || target.name === 'window');
};

const isCrypto = (node) => {
  const target = unwrap(node);
  if (target.type === 'Identifier') return target.name === 'crypto';
  return target.type === 'MemberExpression' && memberName(target) === 'crypto' && isGlobalObject(target.object);
};

export default {
  meta: { name: 'kimi' },
  rules: {
    'no-crypto-random-uuid': {
      meta: {
        type: 'problem',
        messages: {
          forbidden: 'Do not use crypto.randomUUID(); use v4 from uuid instead.',
        },
      },
      create(context) {
        return {
          MemberExpression(node) {
            if (memberName(node) === 'randomUUID' && isCrypto(node.object)) {
              context.report({ node, messageId: 'forbidden' });
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== 'ObjectPattern' || node.init === null || !isCrypto(node.init)) return;
            if (node.id.properties.some((property) => property.type === 'Property' && propertyName(property) === 'randomUUID')) {
              context.report({ node: node.id, messageId: 'forbidden' });
            }
          },
        };
      },
    },
  },
};
