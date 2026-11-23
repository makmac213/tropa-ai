"""Reading "out of credits" / usage limits off an agent's screen: its own CLI's error counts; a quote of one, or an old one,
doesn't (python3 -m unittest discover -s tests)."""
import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kit", ".agent_sync"))
import room_watcher as rw  # noqa: E402

BOX = ["╭──────────────────────────────────────╮", "│ >                                    │", "╰──────────────────────────────────────╯", "  ? for shortcuts"]


class LimitTest(unittest.TestCase):
    def test_the_cli_own_credits_error_counts(self):
        rows = ["> check the totals", "  ⎿  Credit balance is too low · Add funds: https://console.anthropic.com/settings/billing", ""] + BOX
        self.assertEqual(rw.limit_in(rows)[0], "credits")

    def test_a_usage_limit_counts(self):
        rows = ["■ You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes."] + BOX
        kind, _, resets = rw.limit_in(rows)
        self.assertEqual(kind, "limit")
        self.assertIn("2 hours", resets)

    def test_room_messages_quoting_it_dont(self):
        rows = ["● tropa - read_messages (MCP)(agent: \"PH-QA-2\", room: \"project:ph\")",
                "  ⎿  [#812] watcher: @Mark 💳 `PH-QA-1` is out of credits with its AI provider, so TropaAI pauses it",
                "     > Personal is out of credits",
                "     [#813] PH-PM: @PH-QA-2 PH-QA-1 is out of credits, take its card",
                "     [#814] watcher: ⏸ `PH-QA-1` is paused (out of credits)",
                "● On it: taking card #42 from PH-QA-1."] + BOX
        self.assertIsNone(rw.limit_in(rows))

    def test_an_old_error_after_a_normal_reply_doesnt(self):
        rows = ["  ⎿  Credit balance is too low · Add funds", "", "> /login", "  ⎿  Login successful", "> carry on with #42",
                "● Card #42: the export now includes the totals row.", "  Tests pass (14/14).", "  Posted the summary in the room.", ""] + BOX
        self.assertIsNone(rw.limit_in(rows))


if __name__ == "__main__":
    unittest.main()
