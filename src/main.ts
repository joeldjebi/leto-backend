import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { FriendlyErrorsFilter, validationExceptionFactory } from './common/friendly-errors';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // CORS : origines autorisées (back-office). Vide = toutes (développement). Les apps mobiles ne sont pas concernées.
  const origins = (process.env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors(origins.length ? { origin: origins } : undefined);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, exceptionFactory: validationExceptionFactory }));
  // Jamais d'erreur technique affichée aux utilisateurs : messages clairs en français
  app.useGlobalFilters(new FriendlyErrorsFilter());
  const port = process.env.PORT ?? 3000;
  // Écoute sur le serveur seulement : on passe par Apache (HTTPS). HOST=0.0.0.0 pour tester depuis un téléphone sur le Wi-Fi
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`LETO API démarrée sur http://${host}:${port}`);
}
// Démarrage impossible (port déjà pris, base injoignable) : le processus s'arrête, pm2 le signale et le relance
// (sinon il reste « online » sans répondre à personne)
bootstrap().catch((e) => {
  console.error('Démarrage de l’API impossible :', e);
  process.exit(1);
});
