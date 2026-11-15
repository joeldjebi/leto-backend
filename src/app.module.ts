import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './common/auth.guard';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { Company } from './companies/company.entity';
import { DeliveriesController } from './deliveries/deliveries.controller';
import { DeliveriesService } from './deliveries/deliveries.service';
import { Delivery } from './deliveries/delivery.entity';
import { PricingController } from './pricing/pricing.controller';
import { TrackingGateway } from './tracking/tracking.gateway';
import { User } from './users/user.entity';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [User, Company, Delivery],
      // Pratique en dev : crée/maj les tables automatiquement. À remplacer par des migrations en prod.
      synchronize: true,
    }),
    TypeOrmModule.forFeature([User, Company, Delivery]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '30d' },
    }),
  ],
  controllers: [AuthController, CompaniesController, DeliveriesController, PricingController, UsersController],
  providers: [
    AuthService,
    CompaniesService,
    DeliveriesService,
    TrackingGateway,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
