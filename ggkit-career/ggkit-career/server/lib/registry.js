'use strict';

/**
 * Интерфейс проверки номера студенческого билета / зачётной книжки.
 *
 * Сейчас используется закрытая таблица student_registry (вымышленные тестовые записи, которыми управляет администратор).
 * Чтобы подключить официальную базу ГГКИТ, замените findByNumber() вызовом её API/БД и верните запись в том же формате
 * (или сохраните полученные данные в student_registry и верните строку оттуда). Ключи и адреса брать из переменных
 * окружения — в клиентский код они попадать не должны.
 *
 * @returns {Promise<null | {id:number, student_number:string, full_name:string, kind:'student'|'graduate',
 *           group_name:?string, specialty_code:?string, specialty_name:?string, study_years:?string}>}
 */
async function findByNumber(db, studentNumber) {
  return db.get('SELECT * FROM student_registry WHERE student_number = ?', studentNumber) || null;
}

module.exports = { findByNumber };
