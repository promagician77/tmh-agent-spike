// Stand-in for the TMH database. Two operators so isolation can be tested.
// "Now" is Monday 5 Oct 2026, 09:00, operator local time.
export const NOW = '2026-10-05T09:00:00Z';

export function fixture() {
  return {
    operators: {
      op_austin: { name: 'Austin', contact: 'Rachel (Austin operator)', authority: {} },
      // Denver has not yet moved cancellations to autonomous: every one needs a click.
      op_denver: { name: 'Denver', contact: 'Marcus (Denver operator)', authority: { cancel_appointment: 'approve' } },
    },
    clients: {
      c_sarah: { operatorId: 'op_austin', name: 'Sarah Kim', phone: '+15125550101', needs: ['childcare'], history: ['h_maria', 'h_jen'] },
      c_tom:   { operatorId: 'op_austin', name: 'Tom Reed', phone: '+15125550102', needs: ['housekeeping'], history: ['h_maria', 'h_ana'] },
      c_lena:  { operatorId: 'op_austin', name: 'Lena Ortiz', phone: '+15125550103', needs: ['childcare'], history: ['h_maria'] },
      c_priya: { operatorId: 'op_denver', name: 'Priya Nair', phone: '+17205550101', needs: ['housekeeping'], history: ['h_kelly'] },
    },
    helpers: {
      h_maria: { operatorId: 'op_austin', name: 'Maria', phone: '+15125550201', skills: ['childcare', 'housekeeping'] },
      h_jen:   { operatorId: 'op_austin', name: 'Jen', phone: '+15125550202', skills: ['childcare', 'housekeeping'] },
      h_ana:   { operatorId: 'op_austin', name: 'Ana', phone: '+15125550203', skills: ['housekeeping'] },
      h_bea:   { operatorId: 'op_austin', name: 'Bea', phone: '+15125550204', skills: ['childcare'] },
      h_kelly: { operatorId: 'op_denver', name: 'Kelly', phone: '+17205550201', skills: ['housekeeping'] },
    },
    appointments: {
      apt_a1: { operatorId: 'op_austin', clientId: 'c_sarah', helperId: 'h_maria', start: '2026-10-08T13:00:00Z', end: '2026-10-08T16:00:00Z', status: 'booked', seriesId: 's_sarah_thu' },
      apt_a2: { operatorId: 'op_austin', clientId: 'c_tom',   helperId: 'h_maria', start: '2026-10-06T10:00:00Z', end: '2026-10-06T13:00:00Z', status: 'booked' },
      apt_a3: { operatorId: 'op_austin', clientId: 'c_lena',  helperId: 'h_maria', start: '2026-10-06T15:00:00Z', end: '2026-10-06T17:00:00Z', status: 'booked' },
      apt_a4: { operatorId: 'op_austin', clientId: 'c_tom',   helperId: 'h_jen',   start: '2026-10-05T16:00:00Z', end: '2026-10-05T18:00:00Z', status: 'booked' },
      apt_d1: { operatorId: 'op_denver', clientId: 'c_priya', helperId: 'h_kelly', start: '2026-10-07T10:00:00Z', end: '2026-10-07T12:00:00Z', status: 'booked' },
    },
  };
}
