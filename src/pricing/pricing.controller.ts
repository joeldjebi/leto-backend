import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Public } from '../common/decorators';
import { COMMUNES, computePrice } from './pricing';

@Public()
@Controller('pricing')
export class PricingController {
  @Get('communes')
  communes() {
    return COMMUNES;
  }

  @Get('quote')
  quote(@Query('from') from: string, @Query('to') to: string) {
    const list: readonly string[] = COMMUNES;
    if (!list.includes(from) || !list.includes(to)) {
      throw new BadRequestException('Commune inconnue');
    }
    return { from, to, price: computePrice(from, to), currency: 'XOF' };
  }
}
