const held = new Set(['needs_you', 'manual', 'uncertain', 'failed']);
const prepared = new Set(['ready', 'applying']);
const closed = new Set(['closed', 'cancelled']);
const text = value => typeof value === 'string' ? value : '';
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const compareText = (a, b) => text(a).localeCompare(text(b), undefined, { sensitivity: 'base', numeric: true });

export function matchesApplicationFilter(job, filter = 'all') {
  if (filter === 'all' || filter === job.state) return true;
  if (filter === 'preparation') return ['imported', 'preparing'].includes(job.state);
  if (filter === 'held') return held.has(job.state);
  if (filter === 'prepared') return prepared.has(job.state);
  if (filter === 'ended') return closed.has(job.state);
  if (filter === 'confirmed') return ['employer_confirmed', 'fixture'].includes(job.submissionConfirmation);
  if (filter === 'attested') return job.submissionConfirmation === 'candidate_attested';
  return false;
}

export function applicationResults(jobs = [], { query = '', filter = 'all', sort = 'recent' } = {}) {
  const terms = text(query).toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const priority = { uncertain: 0, needs_you: 1, failed: 2, manual: 3, ready: 4, preparing: 5, applying: 6, imported: 7 };
  return jobs.map((job, index) => ({ job, index })).filter(({ job }) => {
    const searchable = [job.title, job.employer, job.url, job.portal, job.location].map(text).join(' ').toLocaleLowerCase();
    return matchesApplicationFilter(job, filter) && terms.every(term => searchable.includes(term));
  }).sort((a, b) => {
    let order = 0;
    if (sort === 'employer') order = compareText(a.job.employer, b.job.employer) || compareText(a.job.title, b.job.title);
    else if (sort === 'attention') order = (priority[a.job.state] ?? 8) - (priority[b.job.state] ?? 8);
    else if (sort === 'deadline') {
      const deadline = job => job.deadlineUncertain === true ? Infinity : timestamp(job.deadline) || Infinity;
      const left = deadline(a.job), right = deadline(b.job);
      order = left === right ? 0 : left < right ? -1 : 1;
    }
    if (order) return order;
    return timestamp(b.job.updatedAt || b.job.createdAt) - timestamp(a.job.updatedAt || a.job.createdAt) || a.index - b.index;
  }).map(({ job }) => job);
}

export function applicationPage(results, { offset = 0, selectedId = null, size = 40 } = {}) {
  const limit = Math.max(1, Math.min(100, Number.isInteger(size) ? size : 40));
  const safeOffset = Number.isInteger(offset) && offset > 0 ? Math.floor(offset / limit) * limit : 0;
  const last = Math.max(0, Math.floor((results.length - 1) / limit) * limit);
  let start = Math.min(safeOffset, last);
  const index = selectedId ? results.findIndex(job => job.id === selectedId) : -1;
  if (index >= 0 && (index < start || index >= start + limit)) start = Math.floor(index / limit) * limit;
  return { items: results.slice(start, start + limit), offset: start, end: Math.min(start + limit, results.length), total: results.length, size: limit };
}

export function packagePostingCurrent(job, pkg) {
  const binding = pkg?.postingBinding;
  return Boolean((job?.identity || job?.id) && job?.posting?.sourceHash && job.postingObservationId && binding
    && binding.jobIdentity === (job.identity || job.id) && binding.sourceHash === job.posting.sourceHash
    && binding.observationId === job.postingObservationId && typeof binding.contentHash === 'string' && binding.contentHash
    && (!job.latestPostingObservationId || job.latestPostingObservationId === job.postingObservationId));
}

export function currentRequirementEntries(job, profileRevision) {
  if (!job?.posting?.sourceHash || !profileRevision || !Array.isArray(job.requirementLedger)
    || job.latestPostingObservationId && job.latestPostingObservationId !== job.postingObservationId) return [];
  return job.requirementLedger.filter(entry => entry.binding?.postingHash === job.posting.sourceHash
    && entry.binding?.profileRevision === profileRevision && entry.binding?.jobIdentity === job.identity);
}
