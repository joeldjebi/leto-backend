/**
 * Comptes de test (idempotent) : npm run seed
 * Le Super Admin est créé automatiquement au démarrage de l'API (voir .env).
 */
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { AppModule } from './app.module';
import { Company } from './companies/company.entity';
import { Role, User } from './users/user.entity';

const COMPANY = { name: 'Rapid Express', phone: '0711111111' };
const USERS: { name: string; phone: string; password: string; role: Role }[] = [
  { name: 'Koffi (gérant Rapid Express)', phone: '0722222222', password: 'secret12', role: Role.COMPANY },
  { name: 'Livreur Test', phone: '0303030303', password: 'test1234', role: Role.DRIVER },
  { name: 'Yao', phone: '0733333333', password: 'secret12', role: Role.DRIVER },
  { name: 'Ali', phone: '0744444444', password: 'secret12', role: Role.DRIVER },
  { name: 'Client Test', phone: '0101010101', password: 'test1234', role: Role.CLIENT },
  { name: 'Boutique Test', phone: '0202020202', password: 'test1234', role: Role.CLIENT },
  { name: 'Boutique Awa', phone: '0555555555', password: 'secret12', role: Role.CLIENT },
];

async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const companies = app.get<Repository<Company>>(getRepositoryToken(Company));
  const users = app.get<Repository<User>>(getRepositoryToken(User));

  const company = (await companies.findOneBy({ name: COMPANY.name })) ?? (await companies.save(COMPANY));
  for (const u of USERS) {
    if (await users.existsBy({ phone: u.phone })) continue;
    await users.save({
      name: u.name,
      phone: u.phone,
      role: u.role,
      passwordHash: await bcrypt.hash(u.password, 10),
      companyId: u.role === Role.COMPANY || u.role === Role.DRIVER ? company.id : null,
    });
    console.log(`+ ${u.role.padEnd(7)} ${u.phone} / ${u.password}  ${u.name}`);
  }
  await app.close();
}
seed();
