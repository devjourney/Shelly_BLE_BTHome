# BLE_BTHome Project

Scripts to run on Shelly smart home devices to respond to BLE events and react accordingly.

## Available Tools
- GitHub MCP server is available — prefer it for reading/searching issues and PRs, PR reviews, and fetching file contents from other branches
- GitHub CLI (`gh`) is authenticated — prefer it for creating PRs from the current branch, auth checks, and shell-pipeline use

## Project Structure
- `Shelly_Plus_RGBW_PM_Lux_Control.js` - Script for controlling the brightness of LEDs attached to a Shelly Plus RGBW PM device based on lux values received from a Shelly BLU Motion device
- `Shelly_Plus_RGBW_PM_Motion_and_Lux_Control.js` - Script for controlling the on/off status and the the brightness of LEDs attached to a Shelly Plus RGBW PM device based on motion and lux values received from a Shelly BLU Motion device
- `Shelly_Light_Door_Control.js` - Script for a Shelly smart relay that turns its switch on/off to follow the open/closed state of a Shelly BLU Door/Window sensor

## Deployment
Push to main branch to auto-deploy.
