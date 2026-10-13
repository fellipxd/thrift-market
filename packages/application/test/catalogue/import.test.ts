import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importListingsCsv, IMPORT_TEMPLATE_CSV, parseCsv } from '../../src';
import { closeTestServices, createShop, createUser, ensureCategory, testServices } from '../support';

afterAll(closeTestServices);
beforeAll(async () => {
  await ensureCategory();
});

const pool = () => testServices().pool;

describe('owned-content CSV import (R24)', () => {
  it('parses quoted fields, doubled quotes, commas, newlines and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(() => parseCsv('a,"open')).toThrow();
  });

  it('creates drafts (never published) for good rows and reports bad ones without leaving half-made drafts', async () => {
    const shop = await createShop();
    const csv = [
      'Title,Category,Sale mode,Price,Min offer,Condition,Size system,Size,Brand,Colour,Material,Description,Quantity',
      '"Linen shirt, relaxed",test-tops,negotiable,8500,7000,good,intl_letter,M,Unbranded,Natural,Linen,"Small mark on cuff, see photos",1',
      'Plain tees,Tops,fixed,3500,,unworn,intl_letter,M,,White,Cotton,Unworn with tags,5',
      'Mystery piece,not-a-category,fixed,1000,,good,uk,10,,,,,1',
      'Bad price,test-tops,fixed,abc,,good,uk,10,,,,,1',
      'Gavel,test-tops,auction,1000,,good,uk,10,,,,,1',
    ].join('\n');
    const res = await importListingsCsv(shop.owner.ctx, { csv });
    expect(res.created.map((c) => c.title)).toEqual(['Linen shirt, relaxed', 'Plain tees']);
    expect(res.errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(res.errors[0]!.message).toMatch(/Unknown category/);
    expect(res.errors[1]!.message).toMatch(/price/i);
    expect(res.errors[2]!.message).toMatch(/Auctions/);
    const rows = (await pool().query(
      `SELECT title, status, sale_mode, price_minor, min_offer_minor, condition, size_label, colour, description, quantity_mode, initial_quantity
         FROM listings WHERE shop_id = $1 ORDER BY title`,
      [shop.id],
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    expect(rows[0]).toMatchObject({ title: 'Linen shirt, relaxed', sale_mode: 'negotiable', condition: 'good', size_label: 'M', description: 'Small mark on cuff, see photos' });
    expect(Number(rows[0]!.price_minor)).toBe(850_000);
    expect(Number(rows[0]!.min_offer_minor)).toBe(700_000);
    expect(rows[1]).toMatchObject({ title: 'Plain tees', quantity_mode: 'equivalent', initial_quantity: 5 });
  });

  it('checks the header, size and who is importing', async () => {
    const shop = await createShop();
    await expect(importListingsCsv(shop.owner.ctx, { csv: 'name,price\nShirt,100' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(importListingsCsv(shop.owner.ctx, { csv: 'title,category,colourway\nShirt,test-tops,red' })).rejects.toThrow(/Unknown column/);
    await expect(importListingsCsv(shop.owner.ctx, { csv: 'title,category' })).rejects.toThrow(/at least one listing/);
    const many = ['title,category', ...Array.from({ length: 201 }, (_, i) => `Item ${i},test-tops`)].join('\n');
    await expect(importListingsCsv(shop.owner.ctx, { csv: many })).rejects.toThrow(/At most 200/);
    const buyer = await createUser();
    await expect(importListingsCsv(buyer.ctx, { csv: IMPORT_TEMPLATE_CSV })).rejects.toBeTruthy();
  });
});
