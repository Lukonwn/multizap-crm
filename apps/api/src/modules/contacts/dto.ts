import type { Contact, ContactTag, Tag } from '@multizap/database';
import type { ContactDTO, TagDTO } from '@multizap/shared';

export const toTagDTO = (t: Tag & { _count?: { contacts: number } }): TagDTO => ({
  id: t.id,
  name: t.name,
  color: t.color,
  ...(t._count && { contactCount: t._count.contacts }),
});

export function toContactDTO(c: Contact & { tags: (ContactTag & { tag: Tag })[] }): ContactDTO {
  return {
    id: c.id,
    accountId: c.accountId,
    name: c.name,
    phoneE164: c.phoneE164,
    origin: c.origin,
    originDetail: c.originDetail,
    consentStatus: c.consentStatus,
    consentAt: c.consentAt?.toISOString() ?? null,
    optedOutAt: c.optedOutAt?.toISOString() ?? null,
    notes: c.notes,
    tags: c.tags.map((ct) => toTagDTO(ct.tag)).sort((a, b) => a.name.localeCompare(b.name)),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export const contactInclude = { tags: { include: { tag: true } } } as const;
