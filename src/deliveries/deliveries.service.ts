import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { Repository } from 'typeorm';
import { AuthUser } from '../common/decorators';
import { computePrice } from '../pricing/pricing';
import { CreateDeliveryDto } from './deliveries.dto';
import { Delivery, DeliveryStatus } from './delivery.entity';

@Injectable()
export class DeliveriesService {
  constructor(@InjectRepository(Delivery) private repo: Repository<Delivery>) {}

  /** Requête de base avec client, livreur et entreprise chargés */
  private query(withCode = false) {
    const qb = this.repo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.client', 'client')
      .leftJoinAndSelect('d.driver', 'driver')
      .leftJoinAndSelect('d.company', 'company')
      .orderBy('d.createdAt', 'DESC');
    return withCode ? qb.addSelect('d.confirmationCode') : qb;
  }

  // ---------- Client ----------

  async create(clientId: string, dto: CreateDeliveryDto) {
    const delivery = await this.repo.save(
      this.repo.create({
        ...dto,
        clientId,
        price: computePrice(dto.pickupCommune, dto.dropoffCommune),
        confirmationCode: randomInt(0, 10000).toString().padStart(4, '0'),
      }),
    );
    return this.query(true).where('d.id = :id', { id: delivery.id }).getOne();
  }

  /** Le client voit ses courses AVEC le code (à transmettre au destinataire) */
  forClient(clientId: string) {
    return this.query(true).where('d.clientId = :clientId', { clientId }).getMany();
  }

  /** Suivi d'une course par le client (rafraîchi régulièrement par l'app) */
  async oneForClient(clientId: string, id: string) {
    const d = await this.query(true)
      .where('d.id = :id AND d.clientId = :clientId', { id, clientId })
      .getOne();
    if (!d) throw new NotFoundException('Course introuvable');
    return d;
  }

  async cancel(clientId: string, id: string) {
    const res = await this.repo.update(
      { id, clientId, status: DeliveryStatus.PENDING },
      { status: DeliveryStatus.CANCELLED },
    );
    if (!res.affected) {
      throw new BadRequestException('Seule une course en attente peut être annulée');
    }
    return this.query(true).where('d.id = :id', { id }).getOne();
  }

  // ---------- Livreur ----------

  /** Courses en attente que n'importe quel livreur peut accepter */
  available() {
    return this.query()
      .where('d.status = :s', { s: DeliveryStatus.PENDING })
      .orderBy('d.createdAt', 'ASC')
      .getMany();
  }

  forDriver(driverId: string) {
    return this.query().where('d.driverId = :driverId', { driverId }).getMany();
  }

  /**
   * Acceptation atomique : l'UPDATE ne réussit que si la course est encore PENDING.
   * Si deux livreurs acceptent en même temps, un seul gagne.
   */
  async accept(user: AuthUser, id: string) {
    const res = await this.repo
      .createQueryBuilder()
      .update(Delivery)
      .set({
        status: DeliveryStatus.ACCEPTED,
        driverId: user.sub,
        companyId: user.companyId,
        acceptedAt: () => 'NOW()',
      })
      .where('id = :id AND status = :s', { id, s: DeliveryStatus.PENDING })
      .execute();
    if (!res.affected) throw new ConflictException('Course déjà prise ou indisponible');
    return this.findOne(id);
  }

  async pickup(driverId: string, id: string) {
    const res = await this.repo.update(
      { id, driverId, status: DeliveryStatus.ACCEPTED },
      { status: DeliveryStatus.PICKED_UP, pickedUpAt: new Date() },
    );
    if (!res.affected) throw new BadRequestException('Action impossible pour cette course');
    return this.findOne(id);
  }

  /** Le livreur saisit le code donné par le destinataire pour clôturer */
  async deliver(driverId: string, id: string, code: string) {
    const d = await this.query(true).where('d.id = :id', { id }).getOne();
    if (!d || d.driverId !== driverId) throw new NotFoundException('Course introuvable');
    if (d.status !== DeliveryStatus.PICKED_UP) {
      throw new BadRequestException("Le colis n'a pas encore été récupéré");
    }
    if (d.confirmationCode !== code) throw new BadRequestException('Code incorrect');
    await this.repo.update(id, { status: DeliveryStatus.DELIVERED, deliveredAt: new Date() });
    return this.findOne(id);
  }

  // ---------- Entreprise / Admin ----------

  forCompany(companyId: string) {
    return this.query().where('d.companyId = :companyId', { companyId }).getMany();
  }

  all() {
    return this.query().getMany();
  }

  private async findOne(id: string) {
    const d = await this.query().where('d.id = :id', { id }).getOne();
    if (!d) throw new NotFoundException('Course introuvable');
    return d;
  }
}
