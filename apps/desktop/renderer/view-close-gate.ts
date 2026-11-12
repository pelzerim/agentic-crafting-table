/** Asks the open view before the person leaves it. A view may answer later, after a save or after asking the
 * person; until then a second request to leave it is dropped, so one prompt gets one answer. */
export class ViewCloseGate {
  private asked?: string;

  /** Runs `leave` once the view of `open` agrees through `confirm`. A view that answers later is left only
   * while `stillOpen` says it is the open one. */
  request(open: string | undefined, confirm: ((id: string) => boolean | Promise<boolean>) | undefined, stillOpen: (id: string) => boolean, leave: () => void) {
    if (!open || !confirm) { leave(); return; }
    if (this.asked === open) return;
    const answer = confirm(open);
    if (typeof answer === 'boolean') { if (answer) leave(); return; }
    this.asked = open;
    void answer.then(agreed => agreed, () => true).then(agreed => {
      if (this.asked === open) this.asked = undefined;
      if (agreed && stillOpen(open)) leave();
    });
  }
}
