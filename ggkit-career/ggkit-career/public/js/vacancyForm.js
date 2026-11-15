// Форма вакансии (работодатель и администратор).
import { loadMeta } from './api.js';
import { h, modal, field, values, withLoading, handleFormError, numOrNull, textOrNull, lines } from './ui.js';

/**
 * buttons: [{ label, kind: 'primary'|'outline', run: async (body) => void }] — run вызывается после успешной проверки на клиенте;
 * ошибки сервера подсвечиваются у полей.
 */
export async function openVacancyForm({ vacancy, title, notice, buttons }) {
  const meta = await loadMeta();
  const v = vacancy || {};
  const listText = (arr) => (arr || []).join('\n');
  const fields = [
    field({ label: 'Название должности', name: 'title', value: v.title || '', required: true, maxlength: 150, full: true }),
    field({ label: 'Категория', name: 'categoryId', value: v.category ? v.category.id : meta.categories[0].id, required: true, options: meta.categories.map((c) => ({ value: c.id, label: c.name })) }),
    field({ label: 'Город', name: 'city', value: v.city || 'Грозный', required: true, maxlength: 80 }),
    field({ label: 'Адрес места работы', name: 'address', value: v.address || '', maxlength: 250, full: true, hint: 'По адресу на странице вакансии строится ссылка на карту.' }),
    field({ label: 'Тип занятости', name: 'employmentType', value: v.employmentType || 'full', required: true, options: meta.employmentTypes }),
    field({ label: 'Требуемый опыт', name: 'experience', value: v.experience || 'none', required: true, options: meta.experienceLevels }),
    field({ label: 'Зарплата от, ₽', name: 'salaryMin', type: 'number', value: v.salaryMin ?? '', min: 0, max: 10000000, inputmode: 'numeric' }),
    field({ label: 'Зарплата до, ₽', name: 'salaryMax', type: 'number', value: v.salaryMax ?? '', min: 0, max: 10000000, inputmode: 'numeric' }),
    field({ label: 'Формат работы', name: 'workFormat', value: v.workFormat || '', maxlength: 120, placeholder: 'Очно, гибрид, сменный график…' }),
    field({ label: 'Подразделение', name: 'department', value: v.department || '', maxlength: 150 }),
    field({ label: 'Описание вакансии', name: 'description', textarea: true, rows: 6, value: v.description || '', required: true, maxlength: 5000, full: true, hint: 'Не менее 20 символов. Абзацы разделяйте пустой строкой.' }),
    field({ label: 'Обязанности', name: 'responsibilities', textarea: true, rows: 4, value: listText(v.responsibilities), full: true, hint: 'Каждый пункт — с новой строки.' }),
    field({ label: 'Требования', name: 'requirements', textarea: true, rows: 4, value: listText(v.requirements), full: true, hint: 'Каждый пункт — с новой строки.' }),
    field({ label: 'Условия работы', name: 'conditions', textarea: true, rows: 4, value: listText(v.conditions), full: true, hint: 'Каждый пункт — с новой строки.' }),
    field({ label: 'Контактное лицо', name: 'contactPerson', value: v.contactPerson || '', maxlength: 150 }),
    field({ label: 'Телефон для связи', name: 'contactPhone', type: 'tel', value: v.contactPhone || '', maxlength: 25 }),
    field({ label: 'Email для связи', name: 'contactEmail', type: 'email', value: v.contactEmail || '', maxlength: 254, full: true }),
  ];
  const body = () => {
    const x = values(fields);
    return {
      title: x.title, categoryId: Number(x.categoryId), city: x.city, address: textOrNull(x.address), employmentType: x.employmentType, experience: x.experience,
      salaryMin: numOrNull(x.salaryMin), salaryMax: numOrNull(x.salaryMax), workFormat: textOrNull(x.workFormat), department: textOrNull(x.department),
      description: x.description, responsibilities: lines(x.responsibilities), requirements: lines(x.requirements), conditions: lines(x.conditions),
      contactPerson: textOrNull(x.contactPerson), contactPhone: textOrNull(x.contactPhone), contactEmail: textOrNull(x.contactEmail),
    };
  };
  let m;
  const btns = buttons.map((b) => h('button', { type: 'button', class: b.kind === 'primary' ? 'btn-primary' : 'btn-outline', onclick: async (e) => {
    await withLoading(e.currentTarget, async () => {
      try { await b.run(body()); m.close(); } catch (err) { handleFormError(err, fields); }
    });
  } }, b.label));
  m = modal({
    title, wide: true,
    body: h('div', { class: 'stack' }, notice ? h('div', { class: 'alert alert-warn' }, notice) : null, h('form', { class: 'form-grid', novalidate: true, onsubmit: (e) => e.preventDefault() }, fields.map((f) => f.el))),
    actions: [h('button', { type: 'button', class: 'btn-outline', onclick: () => m.close() }, 'Отмена'), ...btns],
  });
  return m;
}
