

declare module 'fastify' {
  interface FastifyRequest {
    authPrincipal?: import('./services/auth/principal').AuthPrincipal;
  }
}
