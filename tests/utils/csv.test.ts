import { escapeCsvValue, toCsv } from '../../src/utils/csv.js';

describe('CSV utilities', () => {
  it('escapes commas, quotes, and newlines', () => {
    expect(escapeCsvValue('Tenant, "Jane"\nDoe')).toBe('"Tenant, ""Jane""\nDoe"');
  });

  it('renders headers, empty values, and row endings', () => {
    expect(toCsv(['Name', 'Amount'], [['Jane Doe', '900.00'], ['Credit', '']]))
      .toBe('Name,Amount\r\nJane Doe,900.00\r\nCredit,\r\n');
  });
});
