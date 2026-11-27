import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { Role } from '../users/user.entity';
import { OffersService } from './offers.service';

class ProposeDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  price: number;
}

/** « Proposez votre prix » */
@Controller()
export class OffersController {
  constructor(private service: OffersService) {}

  // ----- Livreur -----
  @Post('deliveries/:id/offers')
  @Roles(Role.DRIVER)
  propose(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProposeDto) {
    return this.service.propose(user, id, dto.price);
  }

  @Post('offers/:id/counter/accept')
  @Roles(Role.DRIVER)
  acceptCounter(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.acceptCounter(user, id);
  }

  @Post('offers/:id/counter/decline')
  @Roles(Role.DRIVER)
  declineCounter(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.declineCounter(user, id);
  }

  @Get('offers/mine')
  @Roles(Role.DRIVER)
  mine(@CurrentUser() user: AuthUser) {
    return this.service.mine(user.sub);
  }

  // ----- Client -----
  @Get('deliveries/:id/offers')
  @Roles(Role.CLIENT)
  forClient(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.forClient(user.sub, id);
  }

  @Post('offers/:id/accept')
  @Roles(Role.CLIENT)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.accept(user.sub, id);
  }

  @Post('offers/:id/counter')
  @Roles(Role.CLIENT)
  counter(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProposeDto) {
    return this.service.counter(user.sub, id, dto.price);
  }

  @Post('offers/:id/decline')
  @Roles(Role.CLIENT)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.decline(user.sub, id);
  }
}
