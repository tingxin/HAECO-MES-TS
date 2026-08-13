function text(value) {
  return value === null || value === undefined ? '' : String(value).toLowerCase();
}

export function normalizeSkillFilter(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

export function matchesAdvancedFilters(card, filters = {}) {
  const skills = normalizeSkillFilter(filters.processSkills ?? filters.processSkill);
  const description = String(filters.processDescription ?? '').trim().toLowerCase();
  const cmm = String(filters.cmm ?? '').trim().toLowerCase();
  const references = Array.isArray(card.referenceDocuments) ? card.referenceDocuments : [];
  if (cmm) {
    const cardCmm = card.documentType === 'CMM'
      ? `${card.refNo ?? ''} ${card.documentRevision ?? ''}` : '';
    const referenceMatch = references.some((doc) => doc.docType === 'CMM'
      && text(`${doc.refNo ?? ''} ${doc.docRevision ?? ''}`).includes(cmm));
    if (!text(cardCmm).includes(cmm) && !referenceMatch) return false;
  }
  if (skills.length === 0 && !description) return true;
  const steps = Array.isArray(card.steps) ? card.steps : [];
  return steps.some((step) => {
    const skillMatches = skills.length === 0 || skills.includes(String(step.skill ?? ''));
    const descriptionMatches = !description
      || text(`${step.descriptionZh ?? ''} ${step.descriptionEn ?? ''}`).includes(description);
    return skillMatches && descriptionMatches;
  });
}

export function filterAndPage(cards, filters = {}, page = 1, pageSize = 20) {
  const matches = cards.filter((card) => matchesAdvancedFilters(card, filters));
  const start = (page - 1) * pageSize;
  return { list: matches.slice(start, start + pageSize), total: matches.length, page, pageSize };
}
