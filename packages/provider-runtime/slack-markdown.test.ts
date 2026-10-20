import test from 'node:test';
import assert from 'node:assert/strict';
import { slackMarkdown } from './slack-markdown.ts';

test('Slack mrkdwn becomes Markdown with links, code, emphasis and mentions', () => {
  const names = { U12345: 'Sam' };
  assert.equal(slackMarkdown('How should we handle plan changes for <@U12345>\'s cohort?', names), 'How should we handle plan changes for @Sam\'s cohort?');
  assert.equal(slackMarkdown('Keep the *current billing cycle*. Details in <https://linear.app/acme/issue/BIL-128|BIL-128>; the flag is `plan_switch_v2`.'),
    'Keep the **current billing cycle**. Details in [BIL-128](https://linear.app/acme/issue/BIL-128); the flag is `plan_switch_v2`.');
  assert.equal(slackMarkdown('_soon_ and ~old~ <https://www.example.com> <#C123|billing> <!here> <@U999>'), '*soon* and ~~old~~ [https://www.example.com](https://www.example.com) \\#billing @here @U999');
  assert.equal(slackMarkdown('<https://www.example.com/a|the *plans* page>'), '[the **plans** page](https://www.example.com/a)');
  assert.equal(slackMarkdown('&gt; quoted\nnext'), '> quoted\nnext');
  assert.equal(slackMarkdown('```\nconst a = 1 &lt; 2;\n```'), '\n```\nconst a = 1 < 2;\n```\n');
});

test('Slack text never becomes markup', () => {
  assert.equal(slackMarkdown('&lt;script&gt;window.x=true&lt;/script&gt; # not [a](b) 2*3*4'), '&lt;script&gt;window.x=true&lt;/script&gt; \\# not \\[a\\](b) 2\\*3\\*4');
  assert.equal(slackMarkdown('<javascript:alert(1)|click>'), '&lt;javascript:alert(1)\\|click&gt;');
  assert.equal(slackMarkdown('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(slackMarkdown('snake_case_name and file_name.ts'), 'snake\\_case\\_name and file\\_name.ts');
});
