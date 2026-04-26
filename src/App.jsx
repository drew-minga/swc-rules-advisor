import { useState, useRef, useEffect } from "react";

const RULES_SECTIONS = [
  { label: "General", url: "https://www.swcombine.com/rules/?General" },
  { label: "Character Creation", url: "https://www.swcombine.com/rules/?Character_Creation" },
  { label: "Movement", url: "https://www.swcombine.com/rules/?Movement" },
  { label: "Vision", url: "https://www.swcombine.com/rules/?Vision" },
  { label: "NPCs", url: "https://www.swcombine.com/rules/?NPCs" },
  { label: "Communication", url: "https://www.swcombine.com/rules/?Communication" },
  { label: "Life and Death", url: "https://www.swcombine.com/rules/?Life_and_Death" },
  { label: "Character Skills", url: "https://www.swcombine.com/rules/?Character_Skills" },
  { label: "Races", url: "https://www.swcombine.com/rules/?Races" },
  { label: "The Force", url: "https://www.swcombine.com/rules/?The_Force" },
  { label: "Factions", url: "https://www.swcombine.com/rules/?Factions" },
  { label: "Ground Combat", url: "https://www.swcombine.com/rules/?Ground_Combat" },
  { label: "Space Combat", url: "https://www.swcombine.com/rules/?Space_Combat" },
  { label: "Ships", url: "https://www.swcombine.com/rules/?Ships" },
  { label: "Vehicles", url: "https://www.swcombine.com/rules/?Vehicles" },
  { label: "Droids", url: "https://www.swcombine.com/rules/?Droids" },
  { label: "Items", url: "https://www.swcombine.com/rules/?Items" },
  { label: "Marketplace", url: "https://www.swcombine.com/rules/?Marketplace" },
  { label: "Economy", url: "https://www.swcombine.com/rules/?Economy" },
  { label: "Production", url: "https://www.swcombine.com/rules/?Production" },
  { label: "Research", url: "https://www.swcombine.com/rules/?Research" },
  { label: "Galaxy Map", url: "https://www.swcombine.com/rules/?Galaxy_Map" },
  { label: "Planetary Grids", url: "https://www.swcombine.com/rules/?Planetary_Grids" },
  { label: "Facilities", url: "https://www.swcombine.com/rules/?Facilities" },
  { label: "Creatures", url: "https://www.swcombine.com/rules/?Creatures" },
];

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

export default function SWCombineAdvisor() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content:
        "Greetings, Combine citizen. I am your Rules Advisor — ask me anything about Star Wars Combine mechanics and I'll search the official rulebooks to answer. Select a section to focus on, or just ask freely.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedSection, setSelectedSection] = useState(null);
  const [sectionOpen, setSectionOpen] = useState(false);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

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

  const clearChat = () =>
    setMessages([
      { role: "assistant", content: "Chat cleared. What would you like to know about Star Wars Combine rules?" },
    ]);

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

        textarea:focus { outline: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,180,0,0.25); border-radius: 2px; }
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
              height: 430,
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
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {msg.content}
                </div>
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
                title="Clear chat"
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.09)",
                  color: "rgba(255,255,255,0.28)",
                  borderRadius: 6,
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ✕
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
