import json
import pathlib
import subprocess
import unittest

BINARY = pathlib.Path(__file__).parent / '.build' / 'picker'


class PickerProtocolTests(unittest.TestCase):
    def test_persistent_refusal_and_validation(self):
        requests = [
            '{"operation":"capture"}',
            '{"operation":"revoke"}',
            '{"operation":"capture","approved":true}',
            'x' * 4097,
            '{"operation":"capture"}',
            '{"operation":"close"}',
        ]
        result = subprocess.run([str(BINARY)], input='\n'.join(requests) + '\n',
                                text=True, capture_output=True, timeout=10, check=True)
        self.assertEqual(result.stderr, '')
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses, [
            {'ok': False, 'code': 'isolation_unverified'},
            {'ok': True, 'event': 'revoked'},
            {'ok': False, 'code': 'invalid_request'},
            {'ok': False, 'code': 'invalid_request'},
            {'ok': False, 'code': 'isolation_unverified'},
            {'ok': True, 'event': 'closed'},
        ])

    def test_eof_terminates(self):
        result = subprocess.run([str(BINARY)], input='', text=True, capture_output=True,
                                timeout=10, check=True)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
