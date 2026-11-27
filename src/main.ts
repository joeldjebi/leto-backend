import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { FriendlyErrorsFilter, validationExceptionFactory } from './common/friendly-errors';

/**
 * Avant la synchronisation TypeORM : la colonne « engin » des courses passe d'une énumération à du texte
 * (engins ajoutés par le SA). Conversion en place, sans perte : sinon TypeORM recréerait la colonne.
 */
async function prepareSchema() {
  if (process.env.DB_SYNC === 'false') return;
  const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await db.connect();
  try {
    const { rows } = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'vehicleType'`);
    if (rows[0]?.data_type === 'USER-DEFINED') {
      await db.query(`ALTER TABLE deliveries ALTER COLUMN "vehicleType" DROP DEFAULT`);
      await db.query(`ALTER TABLE deliveries ALTER COLUMN "vehicleType" TYPE varchar(12) USING "vehicleType"::text`);
      await db.query(`ALTER TABLE deliveries ALTER COLUMN "vehicleType" SET DEFAULT 'MOTO'`);
      console.log('Colonne deliveries.vehicleType convertie en texte');
    }
  } finally {
    await db.end();
  }
}

async function bootstrap() {
  await prepareSchema();
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
  console.log(`VITE API démarrée sur http://${host}:${port}`);
}
// Démarrage impossible (port déjà pris, base injoignable) : le processus s'arrête, pm2 le signale et le relance
// (sinon il reste « online » sans répondre à personne)
bootstrap().catch((e) => {
  console.error('Démarrage de l’API impossible :', e);
  process.exit(1);
});
