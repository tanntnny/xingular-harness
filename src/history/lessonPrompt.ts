// The mission of a reflection run: read how one finished run went and write at most one lesson
// for the Wiki. The lesson shape (a cue, a checkable lesson, the evidence, or NO_ENTRY) is the
// one the refinement library uses (`refine/prompts.ts::experience`), from harness².
import { ANSWER_FREE, EVIDENCE_BOUNDARY } from '../refine/prompts'

export const REFLECTION_IDENTITY = 'You read the record of one finished agent run and decide whether it teaches a lesson worth keeping for later runs. Work only inside the current folder: the evidence is under `context/`. Do not change any file. Follow the mission in the user message exactly.'

export function lessonMission(): string {
  return [
    'Read `context/run.md`: the complete record of one finished run of an agent, in the order it happened -- the request, what the agent said, every tool call and what came back. `context/lessons.md` lists the lessons already kept, one per line, as `path -- cue`.',
    '# WHAT A LESSON IS\n\nA lesson is something a later run, on a different request, would do differently because it read it. It comes from a contrast the record shows: an approach that failed and one that then worked, a tool call that was wasted, a check that caught a mistake, a step that had to be redone.\n\nThe `cue` describes the SHAPE OF SITUATION the lesson applies to, so it can fire on a different matter. Not this run\'s facts -- the pattern. The `lesson` is the operation to perform, stated so it can be applied and checked.\n\nToo generic is useless (\'be thorough\', \'read the code first\'); too specific never fires again (\'the config file is at src/app.json\'). Aim between: \'when a build tool reports a missing module after a dependency upgrade, check the lockfile was regenerated before editing imports\'.\n\nNever put into a lesson a fact about this run\'s subject: names of files, people, projects, values, or anything the user said about their own work. Those are wrong anchors for any other run, and they may be private.',
    '# WHEN TO WRITE NOTHING\n\nMost runs teach nothing new. If the record shows no concrete contrast -- the work simply went as planned, or the only lesson would be generic advice -- reply with the single line NO_ENTRY. That is the expected answer for most runs.\n\nIf one of the lessons in `context/lessons.md` already says the same thing, reply with the single line `SAME <path>` naming it, instead of a new entry.',
    ANSWER_FREE,
    EVIDENCE_BOUNDARY,
    '# OUTPUT FORMAT\n\nExactly one of:\n\nNO_ENTRY\n\nSAME <path from context/lessons.md>\n\n<experience>\ncue: <the shape of situation this applies to, one line>\nlesson: <the operation to perform, one line>\nevidence: <the contrast in the record this rests on, one line, without the subject\'s facts>\nconfidence: <high|medium|low, and why>\n</experience>'
  ].join('\n\n') + '\n'
}
