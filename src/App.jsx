import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RULES_SECTIONS } from "./data/rules-sections.js";

// Markdown renderer for assistant replies. Disallow raw HTML (skipHtml) and
// override link behavior to open externally in a new tab — the model's replies
// regularly cite swcombine.com pages and we want them clickable but isolated.
const markdownComponents = {
  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

const StarField = () => {
  const stars = useRef(
    Array.from({ length: 80 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 2 + 0.5,
      opacity: Math.random() * 0.6 + 0.2,
      delay: Math.random() * 3,
    })),
  ).current;

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0 }}>
      {stars.map((s) => (
        <div
          key={s.id}
          style={{
            position: "absolute",
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.size,
            height: s.size,
            borderRadius: "50%",
            background: "white",
            opacity: s.opacity,
            animation: `twinkle ${2 + s.delay}s ease-in-out infinite alternate`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
};

const INITIAL_GREETING = {
  role: "assistant",
  content:
    "Greetings, Combine citizen. I am your Rules Advisor — ask me anything about Star Wars Combine mechanics and I'll search the official rulebooks to answer. Select a section to focus on, or just ask freely.",
};

export default function SWCombineAdvisor() {
  const [messages, setMessages] = useState([INITIAL_GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedSection, setSelectedSection] = useState(null);
  const [sectionOpen, setSectionOpen] = useState(false);
  // Index of the most recently copied message; reset to null after the
  // confirmation lingers briefly. Indexed instead of keyed-by-id since
  // messages don't have stable ids.
  const [copiedIdx, setCopiedIdx] = useState(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  const handleCopy = async (text, i) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
    } catch {
      /* clipboard unavailable; quietly do nothing */
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: history, section: selectedSection }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.error || "Rate limit reached — please wait a moment and try again.",
          },
        ]);
        return;
      }

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              data.error || "⚠️ The rules database returned an error. Please try again.",
          },
        ]);
        return;
      }

      const reply =
        data.reply || "I wasn't able to retrieve an answer. Please try rephrasing your question.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ Network error contacting the rules database. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([INITIAL_GREETING]);
    setSelectedSection(null);
    setSectionOpen(false);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    textareaRef.current?.focus();
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;800&family=Exo+2:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #020408; }

        @keyframes twinkle {
          from { opacity: 0.15; transform: scale(0.8); }
          to   { opacity: 0.85; transform: scale(1.2); }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulseBorder {
          0%,100% { box-shadow: 0 0 0 0 rgba(255,180,0,0.12); }
          50%      { box-shadow: 0 0 0 4px rgba(255,180,0,0.04); }
        }
        @keyframes bounce {
          0%,80%,100% { transform: scale(0.55); opacity: 0.35; }
          40%          { transform: scale(1);    opacity: 1;    }
        }

        .msg-in  { animation: fadeUp 0.28s ease forwards; }
        .dot-loader span {
          display: inline-block; width: 6px; height: 6px; border-radius: 50%;
          background: #ffb400; margin: 0 2px;
          animation: bounce 1.2s ease-in-out infinite;
        }
        .dot-loader span:nth-child(2) { animation-delay: 0.2s; }
        .dot-loader span:nth-child(3) { animation-delay: 0.4s; }

        .section-pill { cursor: pointer; transition: all 0.18s; }
        .section-pill:hover { border-color: rgba(255,180,0,0.55) !important; color: #ffb400 !important; background: rgba(255,180,0,0.1) !important; }
        .section-pill.on  { border-color: #ffb400 !important; color: #ffb400 !important; background: rgba(255,180,0,0.18) !important; }

        .send-btn { transition: all 0.18s; }
        .send-btn:hover:not(:disabled) { background: #ffb400 !important; color: #0a0c10 !important; transform: scale(1.04); }
        .send-btn:disabled { opacity: 0.38; cursor: not-allowed; }

        .clr-btn { transition: all 0.18s; }
        .clr-btn:hover { color: #ff6b6b !important; border-color: rgba(255,107,107,0.4) !important; }

        .copy-btn { transition: all 0.18s; }
        .copy-btn:hover { color: #ffb400 !important; border-color: rgba(255,180,0,0.4) !important; }

        textarea:focus { outline: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,180,0,0.25); border-radius: 2px; }

        /* Markdown styles, scoped to assistant bubbles only. */
        .advisor-md > :first-child { margin-top: 0; }
        .advisor-md > :last-child  { margin-bottom: 0; }
        .advisor-md p { margin: 0 0 8px; }
        .advisor-md h1, .advisor-md h2, .advisor-md h3,
        .advisor-md h4, .advisor-md h5, .advisor-md h6 {
          font-family: 'Orbitron', monospace;
          color: #ffb400;
          letter-spacing: 1px;
          margin: 12px 0 6px;
          line-height: 1.3;
        }
        .advisor-md h1 { font-size: 16px; }
        .advisor-md h2 { font-size: 14.5px; }
        .advisor-md h3 { font-size: 13.5px; }
        .advisor-md h4, .advisor-md h5, .advisor-md h6 { font-size: 13px; }
        .advisor-md ul, .advisor-md ol { margin: 4px 0 8px 18px; padding: 0; }
        .advisor-md li { margin: 2px 0; }
        .advisor-md strong { color: rgba(255,218,150,1); font-weight: 600; }
        .advisor-md em { color: rgba(255,218,150,0.85); }
        .advisor-md a { color: #ffb400; text-decoration: underline; text-underline-offset: 2px; }
        .advisor-md a:hover { color: #ffd166; }
        .advisor-md code {
          background: rgba(255,180,0,0.08);
          border: 1px solid rgba(255,180,0,0.15);
          padding: 1px 5px;
          border-radius: 4px;
          font-family: ui-monospace, 'SF Mono', Menlo, monospace;
          font-size: 12px;
        }
        .advisor-md pre {
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 6px;
          padding: 10px 12px;
          margin: 8px 0;
          overflow-x: auto;
          font-size: 12px;
        }
        .advisor-md pre code { background: none; border: none; padding: 0; }
        .advisor-md blockquote {
          border-left: 2px solid rgba(255,180,0,0.4);
          margin: 8px 0;
          padding: 2px 12px;
          color: rgba(218,228,244,0.7);
        }
        .advisor-md table { border-collapse: collapse; margin: 8px 0; }
        .advisor-md th, .advisor-md td {
          border: 1px solid rgba(255,255,255,0.12);
          padding: 4px 8px;
          font-size: 12.5px;
        }
        .advisor-md hr {
          border: none;
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 10px 0;
        }

        /* Mobile: prevent iOS Safari auto-zoom on focus by bumping the
           textarea font size to 16px. Also enlarge interactive controls
           slightly so they meet the 44px touch-target guideline. */
        @media (max-width: 480px) {
          .input-textarea { font-size: 16px !important; }
          .send-btn, .clr-btn { height: 36px !important; }
          .copy-btn { font-size: 10.5px !important; padding: 4px 10px !important; }
          .section-pill { padding: 6px 12px !important; font-size: 12px !important; }
        }
      `}</style>

      <div
        style={{
          minHeight: "100vh",
          background: "linear-gradient(145deg,#020408 0%,#060a10 55%,#020408 100%)",
          fontFamily: "'Exo 2', sans-serif",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "24px 16px 32px",
        }}
      >
        <StarField />

        <div
          style={{
            position: "fixed",
            inset: 0,
            pointerEvents: "none",
            zIndex: 1,
            background:
              "repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.025) 2px,rgba(0,0,0,0.025) 4px)",
          }}
        />

        <div style={{ position: "relative", zIndex: 2, width: "100%", maxWidth: 780 }}>
          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: 6,
                color: "#ffb400",
                fontFamily: "'Orbitron',monospace",
                opacity: 0.65,
                marginBottom: 7,
              }}
            >
              STAR WARS COMBINE
            </div>
            <h1
              style={{
                fontFamily: "'Orbitron',monospace",
                fontSize: "clamp(20px,4vw,30px)",
                fontWeight: 800,
                color: "#fff",
                letterSpacing: 3,
                textShadow: "0 0 28px rgba(255,180,0,0.28)",
              }}
            >
              RULES ADVISOR
            </h1>
            <div
              style={{
                width: 72,
                height: 2,
                background: "linear-gradient(90deg,transparent,#ffb400,transparent)",
                margin: "9px auto 0",
              }}
            />
          </div>

          {/* Section Picker */}
          <div
            style={{
              marginBottom: 14,
              background: "rgba(255,255,255,0.018)",
              border: "1px solid rgba(255,180,0,0.1)",
              borderRadius: 8,
              padding: "11px 15px",
            }}
          >
            <div
              onClick={() => setSectionOpen(!sectionOpen)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: 3,
                  color: "rgba(255,255,255,0.38)",
                  textTransform: "uppercase",
                  fontFamily: "'Orbitron',monospace",
                }}
              >
                Focus Section
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                {selectedSection && (
                  <span style={{ fontSize: 12, color: "#ffb400" }}>{selectedSection.label}</span>
                )}
                <span style={{ color: "rgba(255,180,0,0.45)", fontSize: 11 }}>
                  {sectionOpen ? "▲" : "▼"}
                </span>
              </div>
            </div>

            {sectionOpen && (
              <div style={{ marginTop: 11, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {[{ label: "All Sections", url: null }, ...RULES_SECTIONS].map((s) => {
                  const active =
                    s.url === null ? !selectedSection : selectedSection?.label === s.label;
                  return (
                    <button
                      key={s.label}
                      className={`section-pill${active ? " on" : ""}`}
                      onClick={() => {
                        setSelectedSection(s.url ? s : null);
                        setSectionOpen(false);
                      }}
                      style={{
                        padding: "4px 11px",
                        fontSize: 11,
                        borderRadius: 20,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "transparent",
                        color: "rgba(255,255,255,0.42)",
                        fontFamily: "'Exo 2',sans-serif",
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Chat Window */}
          <div
            style={{
              background: "rgba(5,9,17,0.88)",
              border: "1px solid rgba(255,180,0,0.14)",
              borderRadius: 10,
              height: "min(430px, calc(100vh - 320px))",
              minHeight: 280,
              overflowY: "auto",
              padding: "18px 18px",
              marginBottom: 11,
              backdropFilter: "blur(12px)",
              animation: "pulseBorder 4s ease-in-out infinite",
            }}
          >
            {messages.map((msg, i) => (
              <div
                key={i}
                className="msg-in"
                style={{
                  marginBottom: 16,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    letterSpacing: 2.5,
                    color:
                      msg.role === "user"
                        ? "rgba(255,180,0,0.48)"
                        : "rgba(100,180,255,0.48)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    fontFamily: "'Orbitron',monospace",
                  }}
                >
                  {msg.role === "user" ? "You" : "Rules Advisor"}
                </div>
                <div
                  className={msg.role === "assistant" ? "advisor-md" : undefined}
                  style={{
                    maxWidth: "88%",
                    padding: "10px 13px",
                    borderRadius:
                      msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                    background:
                      msg.role === "user"
                        ? "linear-gradient(135deg,rgba(255,180,0,0.11),rgba(255,140,0,0.07))"
                        : "rgba(255,255,255,0.038)",
                    border:
                      msg.role === "user"
                        ? "1px solid rgba(255,180,0,0.22)"
                        : "1px solid rgba(255,255,255,0.07)",
                    fontSize: 13.5,
                    lineHeight: 1.66,
                    color:
                      msg.role === "user"
                        ? "rgba(255,218,90,0.95)"
                        : "rgba(218,228,244,0.9)",
                    whiteSpace: msg.role === "user" ? "pre-wrap" : "normal",
                  }}
                >
                  {msg.role === "assistant" ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      skipHtml
                      components={markdownComponents}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  ) : (
                    msg.content
                  )}
                </div>
                {msg.role === "assistant" && i > 0 && (
                  <button
                    className="copy-btn"
                    onClick={() => handleCopy(msg.content, i)}
                    title="Copy reply (markdown)"
                    style={{
                      marginTop: 5,
                      background: "transparent",
                      border: "1px solid rgba(255,255,255,0.12)",
                      color: "rgba(255,255,255,0.42)",
                      borderRadius: 4,
                      padding: "2px 8px",
                      fontSize: 9.5,
                      letterSpacing: 1.5,
                      fontFamily: "'Orbitron',monospace",
                      cursor: "pointer",
                    }}
                  >
                    {copiedIdx === i ? "COPIED" : "COPY"}
                  </button>
                )}
              </div>
            ))}

            {loading && (
              <div
                className="msg-in"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  marginBottom: 14,
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    letterSpacing: 2.5,
                    color: "rgba(100,180,255,0.48)",
                    marginBottom: 4,
                    textTransform: "uppercase",
                    fontFamily: "'Orbitron',monospace",
                  }}
                >
                  Rules Advisor
                </div>
                <div
                  style={{
                    padding: "11px 15px",
                    background: "rgba(255,255,255,0.038)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: "12px 12px 12px 2px",
                  }}
                >
                  <div className="dot-loader">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input Bar */}
          <div
            style={{
              background: "rgba(5,9,17,0.92)",
              border: "1px solid rgba(255,180,0,0.18)",
              borderRadius: 10,
              padding: "11px 13px",
              display: "flex",
              gap: 9,
              alignItems: "flex-end",
              backdropFilter: "blur(12px)",
            }}
          >
            <textarea
              className="input-textarea"
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={
                selectedSection
                  ? `Ask about ${selectedSection.label} rules…`
                  : "Ask any Star Wars Combine rules question…"
              }
              disabled={loading}
              rows={1}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                resize: "none",
                color: "rgba(218,228,244,0.9)",
                fontSize: 13.5,
                fontFamily: "'Exo 2',sans-serif",
                lineHeight: 1.5,
                padding: "3px 0",
                maxHeight: 100,
                overflow: "auto",
              }}
              onInput={(e) => {
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 100) + "px";
              }}
            />
            <div style={{ display: "flex", gap: 7, alignItems: "center", flexShrink: 0 }}>
              <button
                className="clr-btn"
                onClick={clearChat}
                title="Reset to a new question"
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "rgba(255,255,255,0.55)",
                  borderRadius: 6,
                  padding: "0 13px",
                  height: 32,
                  cursor: "pointer",
                  fontSize: 11,
                  fontFamily: "'Orbitron',monospace",
                  letterSpacing: 1,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                NEW QUERY
              </button>
              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                style={{
                  background: "rgba(255,180,0,0.13)",
                  border: "1px solid rgba(255,180,0,0.38)",
                  color: "#ffb400",
                  borderRadius: 6,
                  padding: "0 15px",
                  height: 32,
                  cursor: "pointer",
                  fontSize: 11,
                  fontFamily: "'Orbitron',monospace",
                  letterSpacing: 1,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                SEND
              </button>
            </div>
          </div>

          <div
            style={{
              textAlign: "center",
              marginTop: 9,
              fontSize: 9,
              color: "rgba(255,255,255,0.13)",
              letterSpacing: 2.5,
              fontFamily: "'Orbitron',monospace",
            }}
          >
            POWERED BY ANTHROPIC · SWCOMBINE.COM RULES
          </div>
        </div>
      </div>
    </>
  );
}
