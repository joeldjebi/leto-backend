import { DataSource, EntityManager } from 'typeorm';

/**
 * Livraison payée par les destinataires : après un changement de prix (proposition acceptée,
 * arrêt annulé), le reste à payer est réparti à parts égales entre les arrêts encore à livrer.
 * Les parts déjà encaissées (arrêts livrés) ne bougent pas.
 */
export async function syncFeeShares(m: DataSource | EntityManager, deliveryId: string) {
  const [d] = await m.query(`SELECT price, "feePaidBy" FROM deliveries WHERE id = $1`, [deliveryId]);
  if (!d || d.feePaidBy !== 'RECIPIENT') return;
  const stops: { id: string; status: string; feeDue: number }[] = await m.query(
    `SELECT id, status, "feeDue" FROM delivery_stops WHERE "deliveryId" = $1 ORDER BY position`,
    [deliveryId],
  );
  const paid = stops.filter((s) => s.status === 'DELIVERED').reduce((t, s) => t + Number(s.feeDue), 0);
  const open = stops.filter((s) => s.status === 'PENDING');
  if (!open.length) return;
  const rest = Math.max(0, Number(d.price) - paid);
  for (const [i, s] of open.entries()) {
    const share = Math.floor(rest / open.length) + (i === 0 ? rest % open.length : 0);
    await m.query(`UPDATE delivery_stops SET "feeDue" = $2 WHERE id = $1`, [s.id, share]);
  }
}
