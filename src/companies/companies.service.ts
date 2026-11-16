import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';
import { PersonDto } from '../common/dto';
import { Role, User } from '../users/user.entity';
import { CreateCompanyDto } from './companies.dto';
import { Company } from './company.entity';

@Injectable()
export class CompaniesService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Company) private companies: Repository<Company>,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  findAll() {
    return this.companies.find({ order: { createdAt: 'DESC' } });
  }

  /** Crée l'entreprise et le compte de son gérant dans une seule transaction */
  async create(dto: CreateCompanyDto) {
    await this.ensurePhoneFree(dto.managerPhone);
    return this.dataSource.transaction(async (m) => {
      const company = await m.save(Company, { name: dto.name, phone: dto.phone });
      await m.save(User, {
        name: dto.managerName,
        phone: dto.managerPhone,
        passwordHash: await bcrypt.hash(dto.managerPassword, 10),
        role: Role.COMPANY,
        companyId: company.id,
      });
      return company;
    });
  }

  async update(id: string, dto: { name?: string; phone?: string }) {
    await this.companies.update(id, dto);
    return this.companies.findOneBy({ id });
  }

  async setActive(id: string, active: boolean) {
    await this.companies.update(id, { active });
    return this.companies.findOneBy({ id });
  }

  listDrivers(companyId: string) {
    return this.users.find({
      where: { companyId, role: Role.DRIVER },
      order: { createdAt: 'DESC' },
    });
  }

  async addDriver(companyId: string, dto: PersonDto) {
    await this.ensurePhoneFree(dto.phone);
    const driver = await this.users.save({
      name: dto.name,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: Role.DRIVER,
      companyId,
    });
    delete driver.passwordHash;
    return driver;
  }

  async setDriverActive(companyId: string, driverId: string, active: boolean) {
    await this.users.update({ id: driverId, companyId, role: Role.DRIVER }, { active });
    return this.users.findOneBy({ id: driverId, companyId });
  }

  private async ensurePhoneFree(phone: string) {
    if (await this.users.existsBy({ phone })) {
      throw new ConflictException('Ce numéro est déjà utilisé');
    }
  }
}
