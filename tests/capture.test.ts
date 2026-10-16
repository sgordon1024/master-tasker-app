import { describe, expect, it } from 'vitest';
import { parseCapture, type CapturePlaces } from '../web/src/lib.ts';

// Wednesday, October 14, 2026.
const TODAY = '2026-10-14';
const places: CapturePlaces = {
  areas: [
    { id: 'a_home', name: 'Home', archived: false },
    { id: 'a_side', name: 'Side projects', archived: false },
    { id: 'a_hobbies', name: 'Hobbies', archived: false },
    { id: 'a_old', name: 'Homework', archived: true },
  ],
  projects: [
    { id: 'p_port', name: 'Portfolio site', areaId: 'a_side', archived: false },
    { id: 'p_garden', name: 'Garden', areaId: 'a_home', archived: false },
  ],
};
const read = (text: string) => parseCapture(text, TODAY, places);

describe('quick capture', () => {
  it('reads today, tomorrow and full weekday names, as before', () => {
    expect(read('Call the vet today')).toMatchObject({ title: 'Call the vet', dueDate: '2026-10-14' });
    expect(read('Call the vet tomorrow')).toMatchObject({ title: 'Call the vet', dueDate: '2026-10-15' });
    expect(read('Call the vet on friday')).toMatchObject({ title: 'Call the vet', dueDate: '2026-10-16' });
    // Today's own weekday means next week's.
    expect(read('Call the vet wednesday')).toMatchObject({ dueDate: '2026-10-21' });
  });

  it('reads short weekdays at the end, or after on, by or due, and leaves common words alone', () => {
    expect(read('Send the deck fri')).toMatchObject({ title: 'Send the deck', dueDate: '2026-10-16' });
    expect(read('Send the deck by thurs to Sam')).toMatchObject({ title: 'Send the deck to Sam', dueDate: '2026-10-15' });
    expect(read('Buy sun cream for the trip')).toMatchObject({ title: 'Buy sun cream for the trip', dueDate: null });
    expect(read('Send the deck next fri')).toMatchObject({ title: 'Send the deck', dueDate: '2026-10-23' });
  });

  it('reads month names, numeric dates, next week and in N days', () => {
    expect(read('Renew the passport Oct 20')).toMatchObject({ title: 'Renew the passport', dueDate: '2026-10-20' });
    expect(read('Renew the passport October 20th')).toMatchObject({ dueDate: '2026-10-20' });
    expect(read('Renew the passport 3 Nov')).toMatchObject({ title: 'Renew the passport', dueDate: '2026-11-03' });
    // A day that has passed this year means next year.
    expect(read('Book the dentist Jan 5')).toMatchObject({ dueDate: '2027-01-05' });
    expect(read('Book the dentist Jan 5 2028')).toMatchObject({ dueDate: '2028-01-05' });
    expect(read('Pay rent 2026-11-01')).toMatchObject({ title: 'Pay rent', dueDate: '2026-11-01' });
    expect(read('Plan the offsite next week')).toMatchObject({ title: 'Plan the offsite', dueDate: '2026-10-19' });
    expect(read('Follow up in 3 days')).toMatchObject({ title: 'Follow up', dueDate: '2026-10-17' });
    expect(read('Follow up in a week')).toMatchObject({ title: 'Follow up', dueDate: '2026-10-21' });
    expect(read('Follow up in two weeks')).toMatchObject({ dueDate: '2026-10-28' });
    expect(read('Report due Feb 30')).toMatchObject({ title: 'Report due Feb 30', dueDate: null });
  });

  it('reads 10/20 in the order this browser writes dates', () => {
    const dayFirst = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2020, 11, 31))[0].type === 'day';
    expect(read('Send the forms 10/20')).toMatchObject({ title: 'Send the forms', dueDate: dayFirst ? null : '2026-10-20' });
    expect(read('Send the forms 20/10')).toMatchObject({ dueDate: dayFirst ? '2026-10-20' : null });
  });

  it('reads a priority', () => {
    expect(read('Fix the leak !high')).toMatchObject({ title: 'Fix the leak', priority: 'high' });
    expect(read('Fix the leak !med')).toMatchObject({ priority: 'medium' });
    expect(read('Fix the leak !urgent')).toMatchObject({ title: 'Fix the leak !urgent', priority: null });
  });

  it('files under #area or #project by name, exact first, then a unique start', () => {
    expect(read('Fix the gate #home')).toMatchObject({ title: 'Fix the gate', areaId: 'a_home', projectId: null, place: 'Home' });
    expect(read('Pick photos #side-projects')).toMatchObject({ title: 'Pick photos', areaId: 'a_side', projectId: null, place: 'Side projects' });
    expect(read('Pick photos #portfolio')).toMatchObject({ areaId: 'a_side', projectId: 'p_port', place: 'Side projects / Portfolio site' });
    expect(read('Plant bulbs #home/garden')).toMatchObject({ areaId: 'a_home', projectId: 'p_garden', place: 'Home / Garden' });
    // Archived areas aren't offered. "Hob" fits only Hobbies.
    expect(read('Tune the guitar #hob')).toMatchObject({ areaId: 'a_hobbies' });
    // "Ho" fits Home and Hobbies, so it isn't read. Nor is a name that isn't there.
    expect(read('Something #ho')).toMatchObject({ title: 'Something #ho', areaId: null });
    expect(read('Call about #1 issue')).toMatchObject({ title: 'Call about #1 issue', areaId: null });
    // Without places, # is left alone.
    expect(parseCapture('Fix the gate #home', TODAY)).toMatchObject({ title: 'Fix the gate #home', areaId: null });
  });

  it('reads all three at once and says what it read', () => {
    const p = read('Call the vet #home tomorrow !high');
    expect(p).toMatchObject({ title: 'Call the vet', dueDate: '2026-10-15', priority: 'high', areaId: 'a_home' });
    expect(p.found).toEqual(['!high', '#home', 'tomorrow']);
  });

  it('only reads standalone words, and never empties the title', () => {
    expect(read("Read Today's paper")).toMatchObject({ title: "Read Today's paper", dueDate: null });
    expect(read('tomorrow')).toMatchObject({ title: 'tomorrow', dueDate: null, found: [] });
    expect(read('#home !high')).toMatchObject({ title: '#home !high', priority: null, areaId: null });
  });
});
