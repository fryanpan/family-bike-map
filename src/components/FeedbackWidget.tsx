import { useState } from 'react'

type Rating = '😊' | '🤔' | '😞' | null

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState<Rating>(null)
  const [text, setText] = useState('')
  const [author, setAuthor] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')

  function reset() {
    setRating(null)
    setText('')
    setAuthor('')
    setStatus('idle')
  }

  function close() {
    setOpen(false)
    setTimeout(reset, 300) // reset after close animation
  }

  async function submit() {
    if (!text.trim() && !rating) return

    const feedbackText = [
      rating ? `Rating: ${rating}` : '',
      text.trim(),
    ].filter(Boolean).join('\n\n')

    setStatus('submitting')
    try {
      const resp = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: feedbackText,
          author: author.trim() || 'Anonymous',
          pageUrl: window.location.href,
        }),
      })
      if (!resp.ok) throw new Error('Failed')
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        className="feedback-fab"
        onClick={() => setOpen(true)}
        title="Send feedback"
        aria-label="Send feedback"
      >
        💬
      </button>

      {/* Sheet */}
      {open && (
        <div className="modal-backdrop" onClick={close}>
          <div className="feedback-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Share feedback</span>
              <button className="modal-close" onClick={close}>✕</button>
            </div>

            {status === 'done' ? (
              <div className="feedback-done">
                <p className="feedback-done-icon">🙏</p>
                <p className="feedback-done-msg">Thanks for the feedback!</p>
                <button className="btn-primary" style={{ marginTop: 16 }} onClick={close}>
                  Close
                </button>
              </div>
            ) : (
              <div className="feedback-body">
                <p className="feedback-prompt">How's the app working for you?</p>

                <div className="feedback-ratings">
                  {(['😊', '🤔', '😞'] as Rating[]).map((r) => (
                    <button
                      key={r!}
                      className={`feedback-rating-btn${rating === r ? ' selected' : ''}`}
                      onClick={() => setRating((prev) => (prev === r ? null : r))}
                    >
                      {r}
                    </button>
                  ))}
                </div>

                <textarea
                  className="feedback-textarea"
                  placeholder="Tell us what you think… (optional)"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                />

                <input
                  className="feedback-name-input"
                  placeholder="Your name (optional)"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                />

                {status === 'error' && (
                  <p className="feedback-error">Something went wrong. Please try again.</p>
                )}

                <button
                  className="btn-primary"
                  disabled={status === 'submitting' || (!text.trim() && !rating)}
                  onClick={submit}
                  style={{ marginTop: 8 }}
                >
                  {status === 'submitting' ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
