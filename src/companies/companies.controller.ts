import { Body, Controller, Get, Param, ParseBoolPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { PersonDto } from '../common/dto';
import { Role } from '../users/user.entity';
import { CreateCompanyDto, UpdateCompanyDto } from './companies.dto';
import { CompaniesService } from './companies.service';

@Controller('companies')
export class CompaniesController {
  constructor(private service: CompaniesService) {}

  // ----- Admin plateforme -----
  @Get()
  @Roles(Role.SUPER_ADMIN)
  findAll() {
    return this.service.findAll();
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  create(@Body() dto: CreateCompanyDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/active')
  @Roles(Role.SUPER_ADMIN)
  setActive(@Param('id') id: string, @Query('value', ParseBoolPipe) value: boolean) {
    return this.service.setActive(id, value);
  }

  // ----- Gérant d'entreprise : ses livreurs -----
  @Get('me/drivers')
  @Roles(Role.COMPANY)
  listDrivers(@CurrentUser() user: AuthUser) {
    return this.service.listDrivers(user.companyId);
  }

  @Post('me/drivers')
  @Roles(Role.COMPANY)
  addDriver(@CurrentUser() user: AuthUser, @Body() dto: PersonDto) {
    return this.service.addDriver(user.companyId, dto);
  }

  @Patch('me/drivers/:id/active')
  @Roles(Role.COMPANY)
  setDriverActive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('value', ParseBoolPipe) value: boolean,
  ) {
    return this.service.setDriverActive(user.companyId, id, value);
  }
}
