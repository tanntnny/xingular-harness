import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify_terminal', Path(__file__).with_name('verify-terminal.py'))
verify_terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_terminal)


class RoutingTests(unittest.TestCase):
    def test_skips_session_state_after_latest_user(self):
        messages = [
            {'role': 'user', 'content': 'verify-old'},
            {'role': 'assistant', 'content': 'done'},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'verify-flow'}]},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'Name: test.\nTodo for this run: empty.\nThis run continues the conversation; the todo list resets for each run.'}]},
            {'role': 'tool', 'content': 'result'},
        ]
        index, text = verify_terminal.current_user_message(messages)
        self.assertEqual((index, text), (2, 'verify-flow'))
        self.assertEqual(sum(message['role'] == 'tool' for message in messages[index + 1:]), 1)

    def test_first_turn_and_no_user(self):
        messages = [{'role': 'user', 'content': 'verify-todo'}, {'role': 'user', 'content': 'Todo for this run: empty.\nThis is the first turn in this native session.'}]
        self.assertEqual(verify_terminal.current_user_message(messages), (0, 'verify-todo'))
        self.assertEqual(verify_terminal.current_user_message([]), (-1, ''))


if __name__ == '__main__':
    unittest.main()
