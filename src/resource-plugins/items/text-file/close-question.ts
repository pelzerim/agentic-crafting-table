import type { OpenTextFile } from './open-file.ts';

/** The part of the open file the question reads and acts on. */
export type FileToClose = Pick<OpenTextFile, 'unsaved' | 'saveError' | 'changedOnDisk' | 'saveOverDisk' | 'discard'>;

/** How the view shows the question. `hide` gets the answer it was closed with. `busy` is true while the
 * person's answer runs, when the buttons are off so a second click cannot start another. */
export type ClosePrompt = { show(question: string): void; hide(agreed: boolean): void; busy(busy: boolean): void };

/** Decides whether a text file view may close. With edits saved automatically it saves them first, over a
 * change on disk too, and asks only when that save did not reach the disk; without, it asks about unsaved
 * edits. One closing save runs and one question is open at a time: whoever asks meanwhile gets the same
 * answer. A save or a read that is still running after `waitMs` is not waited for any longer, so a disk that
 * does not answer cannot keep the view, or a quit, from ever closing. */
export class CloseQuestion {
  private file: FileToClose;
  private prompt: ClosePrompt;
  private waitMs: number;
  private asked?: { answer: Promise<boolean>; give(agreed: boolean): void };
  private closingSave?: Promise<boolean>;
  private closedWhileSaving = false;
  private answering = false;

  constructor(file: FileToClose, prompt: ClosePrompt, waitMs = 5000) { this.file = file; this.prompt = prompt; this.waitMs = waitMs; }

  /** True when the view may close. `shown` says whether the person sees the view: one that is not shown
   * cannot ask, so it agrees. */
  confirmClose({ saveAutomatically, shown }: { saveAutomatically: boolean; shown(): boolean }): boolean | Promise<boolean> {
    if (this.asked) return this.asked.answer;
    if (this.closingSave) return this.closingSave;
    if (!this.file.unsaved) return true;
    if (!saveAutomatically) return shown() ? this.ask(this.file.saveError ? this.notSaved() : 'Unsaved, really close?') : true;
    this.closingSave = this.save().then(finished => {
      const closed = this.closedWhileSaving;
      this.closingSave = undefined; this.closedWhileSaving = false;
      return closed || !this.file.unsaved || !shown() ? true : this.ask(this.notSaved(finished));
    });
    return this.closingSave;
  }

  /** The person keeps the view open. Ignored while an answer already given runs. */
  cancel() { if (!this.answering) this.give(false); }

  /** The person drops the unsaved edits for what the disk holds, and the view closes. */
  closeWithoutSaving() { this.answerAfter(this.endsInTime(this.file.discard()), () => this.give(true)); }

  /** The person saves the edits, over a change on disk too. The view closes when they reached the disk;
   * otherwise the question stays open with the reason. */
  saveAndClose() { this.answerAfter(this.save(), finished => { if (this.file.unsaved) void this.ask(this.notSaved(finished)); else this.give(true); }); }

  /** The view closes whatever the answer would be: an open question is answered with yes, and a closing
   * save that is still running asks nothing when it ends. */
  agree() { if (this.closingSave) this.closedWhileSaving = true; this.give(true); }

  /** Saves the edits over whatever the disk holds. Edits typed while a save ran are saved by the next one,
   * so this ends with the edits on disk or with a save that did not reach it. False when it has not ended in time. */
  private save() {
    return this.endsInTime((async () => {
      do await this.file.saveOverDisk().catch(() => {});
      while (this.file.unsaved && !this.file.saveError && !this.file.changedOnDisk);
    })());
  }

  /** True when `work` ends within `waitMs`, false when it is still running then. */
  private endsInTime(work: Promise<void>) {
    return new Promise<boolean>(resolve => {
      const limit = setTimeout(() => resolve(false), this.waitMs);
      void work.catch(() => {}).then(() => { clearTimeout(limit); resolve(true); });
    });
  }

  private ask(question: string) {
    this.prompt.show(question);
    if (this.asked) return this.asked.answer;
    let give!: (agreed: boolean) => void;
    const answer = new Promise<boolean>(resolve => { give = resolve; });
    this.asked = { answer, give };
    return answer;
  }

  private give(agreed: boolean) {
    const open = this.asked;
    if (!open) return;
    this.asked = undefined; this.prompt.hide(agreed);
    open.give(agreed);
  }

  private notSaved(saveFinished = true) { return `Not saved: ${saveFinished ? this.file.saveError || 'the file changed on disk again' : 'the save has not finished'}. Really close?`; }

  private answerAfter(work: Promise<boolean>, answer: (finished: boolean) => void) {
    this.answering = true; this.prompt.busy(true);
    void work.then(finished => { this.answering = false; this.prompt.busy(false); if (this.asked) answer(finished); });
  }
}
