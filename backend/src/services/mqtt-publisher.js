/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Lazy singleton MQTT publisher for the main backend process. Used to push
// domain events (e.g. inventory replenished) onto the broker so real-time
// consumers — the dashboard's workflow feed and any listeners — can react.
// No-ops safely if the mqtt package or broker is unavailable.

let client = null;
let connecting = false;

function getClient() {
  if (client || connecting) return client;
  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch {
    console.warn('[MqttPublisher] mqtt package not installed; publish is a no-op.');
    return null;
  }

  connecting = true;
  const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
  client = mqtt.connect(brokerUrl, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clientId: `pos-publisher-${process.pid}-${Date.now()}`,
  });
  client.on('connect', () => console.log(`[MqttPublisher] Connected to MQTT broker at ${brokerUrl}`));
  client.on('error', (err) => console.error('[MqttPublisher] MQTT error:', err.message));
  return client;
}

/** Publish a JSON payload to a topic. Best-effort; never throws. */
function publish(topic, payload) {
  try {
    const c = getClient();
    if (!c) return;
    c.publish(topic, JSON.stringify(payload));
  } catch (err) {
    console.error('[MqttPublisher] Failed to publish:', err.message);
  }
}

module.exports = { publish };
