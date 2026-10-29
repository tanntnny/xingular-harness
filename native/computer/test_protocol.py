import json
import pathlib
import subprocess
import unittest

BINARY = pathlib.Path(__file__).parent / '.build' / 'window-capture'
VALID = {'operation': 'capture', 'approved': True, 'windowID': 123,
         'processID': 456, 'processLaunchTime': 1700000000.0}


class ProtocolTests(unittest.TestCase):
    def invoke(self, text):
        result = subprocess.run([str(BINARY)], input=text, text=True, capture_output=True, timeout=5, check=True)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def test_capture_is_unconditionally_disabled(self):
        response = self.invoke(json.dumps(VALID) + '\n')
        self.assertEqual(response['code'], 'isolation_unverified')
        self.assertFalse(response['ok'])
        self.assertNotIn('data', response)

    def test_invalid_requests_are_refused(self):
        cases = ['', '{}\n', 'not json\n', json.dumps({**VALID, 'approved': False}) + '\n',
                 json.dumps({**VALID, 'windowID': 0}) + '\n',
                 json.dumps({**VALID, 'extra': 1}) + '\n', ' ' * 4097 + '\n']
        for case in cases:
            with self.subTest(case=case[:80]):
                response = self.invoke(case)
                self.assertEqual(response['code'], 'invalid_request')
                self.assertFalse(response['ok'])
                self.assertNotIn('data', response)


if __name__ == '__main__':
    unittest.main()
