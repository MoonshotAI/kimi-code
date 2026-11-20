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

const isUnshadowedGlobal = (node, sourceCode) => {
  for (let scope = sourceCode.getScope(node); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) return variable.defs.length === 0;
  }
  return true;
};

const isGlobalObject = (node, sourceCode) => {
  const target = unwrap(node);
  return target.type === 'Identifier'
    && (target.name === 'globalThis' || target.name === 'window' || target.name === 'self')
    && isUnshadowedGlobal(target, sourceCode);
};

const isCrypto = (node, sourceCode) => {
  const target = unwrap(node);
  if (target.type === 'Identifier') return target.name === 'crypto' && isUnshadowedGlobal(target, sourceCode);
  return target.type === 'MemberExpression' && memberName(target) === 'crypto' && isGlobalObject(target.object, sourceCode);
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
            if (memberName(node) === 'randomUUID' && isCrypto(node.object, context.sourceCode)) {
              context.report({ node, messageId: 'forbidden' });
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== 'ObjectPattern' || node.init === null || !isCrypto(node.init, context.sourceCode)) return;
            if (node.id.properties.some((property) => property.type === 'Property' && propertyName(property) === 'randomUUID')) {
              context.report({ node: node.id, messageId: 'forbidden' });
            }
          },
        };
      },
    },
  },
};
