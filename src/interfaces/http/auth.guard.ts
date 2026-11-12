import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Ponto de extensão da autenticação (README seção 2) — propositalmente no-op.
 *
 * Desenho que seria adotado: cada provedor é um client OIDC num IdP externo
 * (Keycloak/Zitadel) e usa o fluxo client_credentials. Este guard validaria
 * o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e conferiria que o claim
 * do client corresponde ao `providerId` do corpo. Ver ARCHITECTURE.md.
 */
@Injectable()
export class AuthGuardPlaceholder implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
