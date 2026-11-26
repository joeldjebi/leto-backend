import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AddressesController } from './addresses/addresses.controller';
import { SavedAddress } from './addresses/saved-address.entity';
import { AdminController } from './admin/admin.controller';
import { StatsService } from './admin/stats.service';
import { BillingController } from './billing/billing.controller';
import { CreditTransaction, Payment } from './billing/billing.entities';
import { BillingService } from './billing/billing.service';
import { SurchargeService } from './pricing/surcharge.service';
import { LogbookEntry } from './logbook/logbook-entry.entity';
import { IndependentProfile } from './independents/independent-profile.entity';
import { IdentityFilesController, IndependentsController } from './independents/independents.controller';
import { IndependentsService } from './independents/independents.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotifyService } from './notifications/notify.service';
import { DispatchService } from './deliveries/dispatch.service';
import { PlanService } from './deliveries/plan.service';
import { OrderAlert } from './deliveries/order-alert.entity';
import { LandingController } from './landing/landing.controller';
import { LandingService } from './landing/landing.service';
import { VideoVisit } from './landing/video-visit.entity';
import { Prospect } from './prospects/prospect.entity';
import { ProspectsController, ProspectsService } from './prospects/prospects';
import { VideoVisitsService } from './landing/video-visits.service';
import { CancelReasonsController, CancelReasonsService } from './cancel-reasons/cancel-reasons';
import { CountriesController, CountriesService } from './countries/countries';
import { Country } from './countries/country.entity';
import { LogbookController } from './logbook/logbook.controller';
import { Remittance } from './remittances/remittance.entity';
import { RemittancesController } from './remittances/remittances.controller';
import { RemittancesService } from './remittances/remittances.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './common/auth.guard';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { Company } from './companies/company.entity';
import { DeliveriesController } from './deliveries/deliveries.controller';
import { TrackController } from './deliveries/track.controller';
import { DeliveriesService } from './deliveries/deliveries.service';
import { DeliveryStop } from './deliveries/delivery-stop.entity';
import { Delivery } from './deliveries/delivery.entity';
import { GeoController } from './geo/geo.controller';
import { GeoService } from './geo/geo.service';
import { MapStyleService } from './geo/map-style.service';
import { Offer } from './offers/offer.entity';
import { OffersController } from './offers/offers.controller';
import { OffersService } from './offers/offers.service';
import { PricingController } from './pricing/pricing.controller';
import { UploadsController } from './uploads/uploads.controller';
import { Setting } from './settings/setting.entity';
import { SettingsService } from './settings/settings.service';
import { StorageService } from './storage/storage.service';
import { TrackingGateway } from './tracking/tracking.gateway';
import { User } from './users/user.entity';
import { UsersController } from './users/users.controller';
import { AffiliationInvite, CompanyEarning, Withdrawal } from './affiliations/affiliation.entities';
import { AffiliationsController } from './affiliations/affiliations.controller';
import { AffiliationsService } from './affiliations/affiliations.service';
import { PayAdvance, Payslip } from './payroll/payroll.entities';
import { PayrollController } from './payroll/payroll.controller';
import { PayrollService } from './payroll/payroll.service';

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
      entities: [User, Company, Delivery, DeliveryStop, Offer, SavedAddress, Setting, Payment, CreditTransaction, Remittance, LogbookEntry, IndependentProfile, Country, VideoVisit, Prospect, OrderAlert, AffiliationInvite, CompanyEarning, Withdrawal, Payslip, PayAdvance],
      // Crée / met à jour les tables au démarrage (DB_SYNC=false pour désactiver).
      // À remplacer par des migrations TypeORM quand le schéma sera stabilisé.
      synchronize: process.env.DB_SYNC !== 'false',
    }),
    TypeOrmModule.forFeature([User, Company, Delivery, DeliveryStop, Offer, SavedAddress, Setting, Payment, CreditTransaction, Remittance, LogbookEntry, IndependentProfile, Country, VideoVisit, Prospect, OrderAlert, AffiliationInvite, CompanyEarning, Withdrawal, Payslip, PayAdvance]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '30d' },
    }),
  ],
  controllers: [
    AddressesController,
    AdminController,
    AuthController,
    BillingController,
    CompaniesController,
    DeliveriesController,
    GeoController,
    OffersController,
    PricingController,
    TrackController,
    RemittancesController,
    LogbookController,
    IndependentsController,
    IdentityFilesController,
    NotificationsController,
    LandingController,
    CancelReasonsController,
    CountriesController,
    ProspectsController,
    UploadsController,
    UsersController,
    AffiliationsController,
    PayrollController,
  ],
  providers: [
    AuthService,
    BillingService,
    CompaniesService,
    DeliveriesService,
    GeoService,
    MapStyleService,
    OffersService,
    StorageService,
    SettingsService,
    SurchargeService,
    RemittancesService,
    StatsService,
    IndependentsService,
    NotifyService,
    DispatchService,
    PlanService,
    LandingService,
    VideoVisitsService,
    CancelReasonsService,
    CountriesService,
    ProspectsService,
    AffiliationsService,
    PayrollService,
    TrackingGateway,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
