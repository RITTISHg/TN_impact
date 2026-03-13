#define VOLTAGE_PIN 34
#define CURRENT_PIN 35

// Calibration Factors (matched to actual meter: 225V, 2.9A)
float currentCal = 20.61;  // Calibrated: sensor 5.213A -> actual 2.9A
float voltageCal = 462.32; // Calibrated: sensor 216.12V -> actual 225V

// Smoothing variables
float smoothedAmps = 0.0;
float smoothedVolts = 0.0;

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  Serial.println("Starting Voltage and Current Measurement...");
}

void loop() {
  int maxAdcI = 0, minAdcI = 4095;
  int maxAdcV = 0, minAdcV = 4095;
  
  uint32_t startTime = millis();
  while((millis() - startTime) < 200) {
    int rawI = analogRead(CURRENT_PIN);
    if (rawI > maxAdcI) maxAdcI = rawI;
    if (rawI < minAdcI) minAdcI = rawI;
    
    int rawV = analogRead(VOLTAGE_PIN);
    if (rawV > maxAdcV) maxAdcV = rawV;
    if (rawV < minAdcV) minAdcV = rawV;
  }
  
  // Convert Current ADC peak-to-peak to Volts
  float p2pVoltsI = (maxAdcI - minAdcI) * (3.3 / 4095.0);
  if (p2pVoltsI < 0.02) p2pVoltsI = 0.0; // Current noise filter (lowered: 0.05 was too aggressive)
  
  // Convert Voltage ADC peak-to-peak to Volts
  float p2pVoltsV = (maxAdcV - minAdcV) * (3.3 / 4095.0);
  if (p2pVoltsV < 0.05) p2pVoltsV = 0.0; // Voltage noise filter
  
  // Calculate RMS
  float rmsI = (p2pVoltsI / 2.0) * 0.707;
  float rmsV = (p2pVoltsV / 2.0) * 0.707;
  
  // Apply Calibration Factors
  float currentAmps = rmsI * currentCal;
  float mainsVoltage = rmsV * voltageCal;
  
  // Smoothing & Snap-to-Zero for Current
  if (currentAmps == 0.0 && smoothedAmps < 0.01) {
      smoothedAmps = 0.0;
  } else {
      smoothedAmps = (smoothedAmps * 0.7) + (currentAmps * 0.3);
  }
  
  // Smoothing & Snap-to-Zero for Voltage
  if (mainsVoltage == 0.0 && smoothedVolts < 5.0) {
      smoothedVolts = 0.0;
  } else {
      smoothedVolts = (smoothedVolts * 0.8) + (mainsVoltage * 0.2);
  }
  
  // Print Results — compact CSV: "voltage,current\n"
  // Format chosen for zero-regex, split()-only Python parsing (maximum speed).
  Serial.print(smoothedVolts, 2);
  Serial.print(',');
  Serial.println(smoothedAmps, 3);
  // No extra delay — the 200 ms ADC sampling window above already limits rate.
}