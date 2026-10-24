import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { text } from '../server/params'

export function doctorServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'doctor.start': (params) => harness.doctor.start(params as import('./types').DoctorInput),
    'doctor.read': (params) => harness.doctor.read(text(params, 'id')),
    'doctor.cancel': (params) => harness.doctor.cancel(text(params, 'id'))
  }
}
