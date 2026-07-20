import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './lib.jsx'

// per-brand "enable USB debugging" steps; the menus differ across Android skins
const BRANDS = {
  pixel: {
    name: 'Google Pixel',
    steps: [
      'Settings › About phone › tap Build number 7 times',
      'Settings › System › Developer options › turn on USB debugging',
    ],
  },
  samsung: {
    name: 'Samsung',
    steps: [
      'Settings › About phone › Software information › tap Build number 7 times',
      'Settings › Developer options › turn on USB debugging',
    ],
  },
  xiaomi: {
    name: 'Xiaomi, Redmi or POCO',
    steps: [
      'Settings › About phone › tap the MIUI/HyperOS version 7 times',
      'Sign in to a Mi account (MIUI needs one first)',
      'Settings › Additional settings › Developer options › turn on USB debugging and USB debugging (Security settings)',
    ],
  },
  oneplus: {
    name: 'OnePlus',
    steps: [
      'Settings › About device › tap Build number 7 times',
      'Settings › System › Developer options › turn on USB debugging',
    ],
  },
  other: {
    name: 'Another Android phone',
    steps: [
      'Find Build number in Settings (usually under About phone) and tap it 7 times',
      'Open the new Developer options menu and turn on USB debugging',
    ],
  },
}

const TOTAL = 5

export default function Setup({ onConnected }) {
  const [step, setStep] = useState(0) // 0 welcome · 1 enable · 2 detect · 3 wireless · 4 done
  const [brand, setBrand] = useState('pixel')
  const [devices, setDevices] = useState([])
  const [wireless, setWireless] = useState({ state: 'idle', error: '' }) // idle|working|blocked|error|ok
  const polling = useRef(false)

  useEffect(() => {
    if (step !== 2) { polling.current = false; return }
    polling.current = true
    let alive = true
    const tick = async () => {
      if (!alive || !polling.current) return
      const res = await window.crate.devices()
      if (alive && res.ok) {
        setDevices(res.data)
        if (res.data.find((d) => d.state === 'device')) { polling.current = false; setStep(3); return }
      }
      if (alive && polling.current) setTimeout(tick, 1500)
    }
    tick()
    return () => { alive = false; polling.current = false }
  }, [step])

  const goWireless = async () => {
    setWireless({ state: 'working', error: '' })
    const res = await window.crate.goWireless()
    if (res.ok) { setWireless({ state: 'ok', error: '' }); setStep(4) }
    else if (res.error === 'LOCAL_NETWORK_BLOCKED') setWireless({ state: 'blocked', error: '' })
    else setWireless({ state: 'error', error: res.error || 'Could not switch to wireless' })
  }

  const unauth = devices.find((d) => d.state === 'unauthorized')
  const Steps = ({ items }) => (
    <ol className="wsteps">
      {items.map((s, i) => {
        const parts = s.split(' › ')
        return (
          <li key={i}>
            <span className="wstep-dot" />
            <span className="wstep-t">
              {parts.length > 1
                ? parts.map((p, j) => <React.Fragment key={j}>{j > 0 && <span className="wstep-sep">›</span>}{p}</React.Fragment>)
                : s}
            </span>
          </li>
        )
      })}
    </ol>
  )

  let body, actions
  if (step === 0) {
    body = (<>
      <h2>Welcome to Crate</h2>
      <p className="lede">Your phone’s music, on your Mac. Connecting takes about a minute, and you only do it once.</p>
      <ul className="wfeatures">
        <li><span className="wf-ic"><Icon.grid /></span><div><b>Your whole collection</b><span>Every album, cover art and all</span></div></li>
        <li><span className="wf-ic"><Icon.play /></span><div><b>Play on your Mac</b><span>Preview any track before you touch the phone</span></div></li>
        <li><span className="wf-ic"><Icon.plus /></span><div><b>Drag to add</b><span>Drop files or whole folders to send them over</span></div></li>
      </ul>
    </>)
    actions = <button className="btn accent wfull" onClick={() => setStep(1)}>Get started</button>
  } else if (step === 1) {
    body = (<>
      <h2>Turn on USB debugging</h2>
      <p className="lede">This is how your Mac talks to your phone.</p>
      <label className="wlabel">Which phone do you have?</label>
      <div className="wselect">
        <select value={brand} onChange={(e) => setBrand(e.target.value)}>
          {Object.entries(BRANDS).map(([k, b]) => <option key={k} value={k}>{b.name}</option>)}
        </select>
        <span className="wselect-caret">▾</span>
      </div>
      <Steps items={BRANDS[brand].steps} />
    </>)
    actions = (<>
      <button className="btn" onClick={() => setStep(0)}>Back</button>
      <button className="btn accent" onClick={() => setStep(2)}>Done, plug it in</button>
    </>)
  } else if (step === 2) {
    body = (<>
      <h2>Plug in your phone</h2>
      <p className="lede">Connect it to this Mac with a USB cable. You only need the cable for setup.</p>
      <div className="wstatus">
        {unauth
          ? <><span className="dot off" /><span>Your phone is asking to trust this Mac. Tap <b>Allow</b> on its screen and check “Always allow”.</span></>
          : <><span className="spinner" /><span>Waiting for your phone…</span></>}
      </div>
    </>)
    actions = <button className="btn" onClick={() => setStep(1)}>Back</button>
  } else if (step === 3 && wireless.state === 'blocked') {
    body = (<>
      <h2>One quick permission</h2>
      <p className="lede">macOS is blocking Crate from reaching your phone. Grant it once and wireless works from here on.</p>
      <Steps items={['Open Privacy & Security › Local Network and turn Crate on', 'Come back and press Try again (keep the cable in until it connects)']} />
    </>)
    actions = (<>
      <button className="btn" onClick={() => window.crate.openLocalNetworkSettings()}>Open settings</button>
      <button className="btn accent" onClick={goWireless}>Try again</button>
    </>)
  } else if (step === 3) {
    body = (<>
      <h2>Go wireless</h2>
      <p className="lede">Your phone is connected over USB. Switch to WiFi so you can unplug the cable. Crate reconnects on its own next time.</p>
      {wireless.state === 'error' && <div className="msg err">{wireless.error}</div>}
    </>)
    actions = (<>
      <button className="btn" onClick={() => setStep(4)}>Keep the cable</button>
      <button className="btn accent" onClick={goWireless} disabled={wireless.state === 'working'}>
        {wireless.state === 'working' ? <><span className="spinner" /> Switching…</> : 'Go wireless'}
      </button>
    </>)
  } else {
    body = (<>
      <h2>You’re all set</h2>
      <p className="lede">{wireless.state === 'ok' ? 'Connected over WiFi. You can unplug the cable now.' : 'Connected over USB. You can switch to WiFi any time from the top bar.'}</p>
      <ul className="wfeatures">
        <li><span className="wf-ic"><Icon.plus /></span><div><b>Add music</b><span>Drag files or whole folders onto the window</span></div></li>
        <li><span className="wf-ic"><Icon.download /></span><div><b>Save back to your Mac</b><span>Right-click any album to copy it over</span></div></li>
        <li><span className="wf-ic"><Icon.search /></span><div><b>Fix missing covers</b><span>Hover an album’s art to set or find one</span></div></li>
        <li><span className="wf-ic"><Icon.refresh /></span><div><b>Auto-sync a folder</b><span>Point Crate at a Mac folder in Settings</span></div></li>
      </ul>
    </>)
    actions = <button className="btn accent wfull" onClick={onConnected}>Open my library</button>
  }

  return (
    <div className="center-stage">
      <div className="card wizard">
        <div className="wtop">
          <span className="wcount">{String(step + 1).padStart(2, '0')} / {String(TOTAL).padStart(2, '0')}</span>
          <div className="wbar"><div className="wbar-fill" style={{ width: ((step + 1) / TOTAL) * 100 + '%' }} /></div>
        </div>
        <div className="wbody">{body}</div>
        <div className="wactions">{actions}</div>
      </div>
    </div>
  )
}
