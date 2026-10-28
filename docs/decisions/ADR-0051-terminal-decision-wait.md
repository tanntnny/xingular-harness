# ADR-0051: Revisioned terminal decision waits

The terminal needs timely approval and question updates while avoiding a control request every
100 ms in every idle session. The controller owns the pending inbox, so it exposes a private,
control-key-protected revisioned snapshot with a bounded wait. Every inbox mutation wakes waiters;
the frontend resynchronizes on reconnect. The existing immediate snapshot remains available.

The wait uses a separate socket request, so it does not block other terminal control calls.
Waits time out after 20 seconds and are woken on controller disposal. Client shutdown cancels its
request. No persisted state or public server protocol changes.
