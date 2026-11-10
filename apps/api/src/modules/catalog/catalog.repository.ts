import { Injectable } from '@nestjs/common';
import { Tx } from '../salons/salons.repository';
import {
  AssignmentRecord, CategoryRecord, PricingMode, ServiceRecord, StaffRecord, moneyText,
} from './catalog.types';

type Row = Record<string, any>;

const category = (r: Row): CategoryRecord => ({
  id: r.id, salonId: r.salon_id, name: r.name, description: r.description, imageFileId: r.image_file_id,
  displayOrder: Number(r.display_order), isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
});

const service = (r: Row): ServiceRecord => ({
  id: r.id, salonId: r.salon_id, categoryId: r.category_id, name: r.name, description: r.description,
  durationMinutes: Number(r.duration_minutes), pricingMode: r.pricing_mode, basePrice: moneyText(r.base_price),
  imageFileId: r.image_file_id, isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
});

const staff = (r: Row): StaffRecord => ({
  id: r.id, salonId: r.salon_id, userId: r.user_id, displayName: r.display_name, isOwner: r.is_owner,
  isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at,
});

const assignment = (r: Row): AssignmentRecord => ({ serviceId: r.service_id, staffId: r.staff_id, price: moneyText(r.price) });

export interface PublicCategoryRow extends CategoryRecord { imageKey: string | null }
export interface PublicServiceRow extends ServiceRecord { imageKey: string | null }
export interface PublicAssignmentRow extends AssignmentRecord { staffName: string }

/**
 * All SQL for Phase 4 catalogue tables. Every method takes the transaction opened by TenantDb so Row-Level
 * Security applies; parameters are bound (never concatenated) and carry explicit casts. Every query also
 * filters by salon_id explicitly (defence in depth on top of RLS and the composite foreign keys).
 * Categories, services and staff are soft-deleted (deleted_at); the runtime role cannot hard-delete them.
 */
@Injectable()
export class CatalogRepository {
  // ------------------------------------------------------------------ categories
  async listCategories(tx: Tx, salonId: string): Promise<CategoryRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM service_categories WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL ORDER BY display_order, lower(name), id`;
    return r.map(category);
  }

  async findCategory(tx: Tx, salonId: string, id: string): Promise<CategoryRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM service_categories WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return r[0] ? category(r[0]) : null;
  }

  async nextCategoryOrder(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM service_categories WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  async insertCategory(tx: Tx, salonId: string, c: { name: string; description: string | null; isActive: boolean; displayOrder: number }, now: Date): Promise<CategoryRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO service_categories (salon_id, name, description, is_active, display_order, created_at, updated_at)
      VALUES (${salonId}::uuid, ${c.name}::varchar, ${c.description}::varchar, ${c.isActive}::boolean, ${c.displayOrder}::int, ${now}::timestamptz, ${now}::timestamptz)
      RETURNING *`;
    return category(r[0]);
  }

  async updateCategory(tx: Tx, salonId: string, id: string, c: { name: string; description: string | null; isActive: boolean }, now: Date): Promise<CategoryRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE service_categories SET name = ${c.name}::varchar, description = ${c.description}::varchar, is_active = ${c.isActive}::boolean,
        updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL RETURNING *`;
    return category(r[0]);
  }

  async setCategoryOrder(tx: Tx, salonId: string, id: string, order: number, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE service_categories SET display_order = ${order}::int, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  async setCategoryImage(tx: Tx, salonId: string, id: string, fileId: string | null, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE service_categories SET image_file_id = ${fileId}::uuid, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  async softDeleteCategory(tx: Tx, salonId: string, id: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE service_categories SET deleted_at = ${now}::timestamptz, is_active = false, image_file_id = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  async countCategories(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM service_categories WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  async countServicesInCategory(tx: Tx, salonId: string, categoryId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT count(*)::int AS n FROM services WHERE salon_id = ${salonId}::uuid AND category_id = ${categoryId}::uuid AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  // ------------------------------------------------------------------ services
  async listServices(tx: Tx, salonId: string): Promise<ServiceRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM services WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL ORDER BY lower(name), id`;
    return r.map(service);
  }

  async findService(tx: Tx, salonId: string, id: string): Promise<ServiceRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM services WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return r[0] ? service(r[0]) : null;
  }

  async countServices(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM services WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  async insertService(
    tx: Tx, salonId: string,
    s: { categoryId: string; name: string; description: string | null; durationMinutes: number; mode: PricingMode; basePrice: string | null; isActive: boolean },
    now: Date,
  ): Promise<ServiceRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO services (salon_id, category_id, name, description, duration_minutes, pricing_mode, base_price, is_active, created_at, updated_at)
      VALUES (${salonId}::uuid, ${s.categoryId}::uuid, ${s.name}::varchar, ${s.description}::varchar, ${s.durationMinutes}::int,
              ${s.mode}::service_pricing_mode, ${s.basePrice}::numeric, ${s.isActive}::boolean, ${now}::timestamptz, ${now}::timestamptz)
      RETURNING *`;
    return service(r[0]);
  }

  async updateService(
    tx: Tx, salonId: string, id: string,
    s: { categoryId: string; name: string; description: string | null; durationMinutes: number; mode: PricingMode; basePrice: string | null; isActive: boolean },
    now: Date,
  ): Promise<ServiceRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE services SET category_id = ${s.categoryId}::uuid, name = ${s.name}::varchar, description = ${s.description}::varchar,
        duration_minutes = ${s.durationMinutes}::int, pricing_mode = ${s.mode}::service_pricing_mode, base_price = ${s.basePrice}::numeric,
        is_active = ${s.isActive}::boolean, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL RETURNING *`;
    return service(r[0]);
  }

  async setServiceImage(tx: Tx, salonId: string, id: string, fileId: string | null, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE services SET image_file_id = ${fileId}::uuid, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  async softDeleteService(tx: Tx, salonId: string, id: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE services SET deleted_at = ${now}::timestamptz, is_active = false, image_file_id = NULL, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  // ------------------------------------------------------------------ staff-service assignments
  async listAssignments(tx: Tx, salonId: string): Promise<AssignmentRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT ss.service_id, ss.staff_id, ss.price FROM staff_services ss
      JOIN services s ON s.salon_id = ss.salon_id AND s.id = ss.service_id AND s.deleted_at IS NULL
      JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.deleted_at IS NULL
      WHERE ss.salon_id = ${salonId}::uuid
      ORDER BY lower(sp.display_name), sp.id`;
    return r.map(assignment);
  }

  async listAssignmentsOf(tx: Tx, salonId: string, serviceId: string): Promise<AssignmentRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT service_id, staff_id, price FROM staff_services WHERE salon_id = ${salonId}::uuid AND service_id = ${serviceId}::uuid`;
    return r.map(assignment);
  }

  async deleteAssignmentsOf(tx: Tx, salonId: string, serviceId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM staff_services WHERE salon_id = ${salonId}::uuid AND service_id = ${serviceId}::uuid`;
  }

  async deleteAssignmentsOfStaff(tx: Tx, salonId: string, staffId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM staff_services WHERE salon_id = ${salonId}::uuid AND staff_id = ${staffId}::uuid`;
  }

  /** Must run AFTER the service row carries `mode` (composite foreign key service_id + pricing_mode). */
  async insertAssignment(tx: Tx, salonId: string, serviceId: string, staffId: string, mode: PricingMode, price: string | null): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO staff_services (salon_id, service_id, staff_id, pricing_mode, price)
      VALUES (${salonId}::uuid, ${serviceId}::uuid, ${staffId}::uuid, ${mode}::service_pricing_mode, ${price}::numeric)`;
  }

  // ------------------------------------------------------------------ staff roster
  async listStaff(tx: Tx, salonId: string): Promise<StaffRecord[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM staff_profiles WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL ORDER BY is_owner DESC, lower(display_name), id`;
    return r.map(staff);
  }

  async countStaff(tx: Tx, salonId: string): Promise<number> {
    const r = await tx.$queryRaw<Row[]>`SELECT count(*)::int AS n FROM staff_profiles WHERE salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return Number(r[0].n);
  }

  async findStaff(tx: Tx, salonId: string, id: string): Promise<StaffRecord | null> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT * FROM staff_profiles WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
    return r[0] ? staff(r[0]) : null;
  }

  async insertStaff(tx: Tx, salonId: string, s: { userId: string | null; displayName: string; isOwner: boolean }, now: Date): Promise<StaffRecord> {
    const r = await tx.$queryRaw<Row[]>`
      INSERT INTO staff_profiles (salon_id, user_id, display_name, is_owner, created_at, updated_at)
      VALUES (${salonId}::uuid, ${s.userId}::uuid, ${s.displayName}::varchar, ${s.isOwner}::boolean, ${now}::timestamptz, ${now}::timestamptz)
      RETURNING *`;
    return staff(r[0]);
  }

  async updateStaff(tx: Tx, salonId: string, id: string, s: { displayName: string; isActive: boolean }, now: Date): Promise<StaffRecord> {
    const r = await tx.$queryRaw<Row[]>`
      UPDATE staff_profiles SET display_name = ${s.displayName}::varchar, is_active = ${s.isActive}::boolean, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL RETURNING *`;
    return staff(r[0]);
  }

  async softDeleteStaff(tx: Tx, salonId: string, id: string, now: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE staff_profiles SET deleted_at = ${now}::timestamptz, is_active = false, updated_at = ${now}::timestamptz
      WHERE id = ${id}::uuid AND salon_id = ${salonId}::uuid AND deleted_at IS NULL`;
  }

  // ------------------------------------------------------------------ public (APPROVED salons, inside withPublicRead)
  async publicCategories(tx: Tx, salonId: string): Promise<PublicCategoryRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT c.*, f.storage_key AS image_key
      FROM service_categories c
      LEFT JOIN salon_files f ON f.id = c.image_file_id AND f.salon_id = c.salon_id AND f.deleted_at IS NULL AND f.doc_type = 'CATALOG'
      WHERE c.salon_id = ${salonId}::uuid AND c.is_active AND c.deleted_at IS NULL
      ORDER BY c.display_order, lower(c.name), c.id`;
    return r.map((x) => ({ ...category(x), imageKey: (x.image_key as string | null) ?? null }));
  }

  async publicServices(tx: Tx, salonId: string): Promise<PublicServiceRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT s.*, f.storage_key AS image_key
      FROM services s
      JOIN service_categories c ON c.salon_id = s.salon_id AND c.id = s.category_id AND c.is_active AND c.deleted_at IS NULL
      LEFT JOIN salon_files f ON f.id = s.image_file_id AND f.salon_id = s.salon_id AND f.deleted_at IS NULL AND f.doc_type = 'CATALOG'
      WHERE s.salon_id = ${salonId}::uuid AND s.is_active AND s.deleted_at IS NULL
      ORDER BY lower(s.name), s.id`;
    return r.map((x) => ({ ...service(x), imageKey: (x.image_key as string | null) ?? null }));
  }

  /** Only ACTIVE, non-deleted staff are ever shown to customers. */
  async publicAssignments(tx: Tx, salonId: string): Promise<PublicAssignmentRow[]> {
    const r = await tx.$queryRaw<Row[]>`
      SELECT ss.service_id, ss.staff_id, ss.price, sp.display_name AS staff_name
      FROM staff_services ss
      JOIN staff_profiles sp ON sp.salon_id = ss.salon_id AND sp.id = ss.staff_id AND sp.is_active AND sp.deleted_at IS NULL
      WHERE ss.salon_id = ${salonId}::uuid
      ORDER BY lower(sp.display_name), sp.id`;
    return r.map((x) => ({ ...assignment(x), staffName: x.staff_name as string }));
  }
}
