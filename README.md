# Weather Node (1080) #
by Bill Wilkins
Version: 0.1

## What is Weather Node ##

A simple nodejs service that provides a HTTP weather service for the 1080 based USB Weather Station. Based on a lot of the work done by Jim Easterbrook and others on the pywws (Python) scripts. I have this installed on a Raspberry Pi running Wheezy.

### Data and UI Services Provided ###

http://<server>:<port>/weather/settings - return JSON object for station settings
http://<server>:<port>/weather/now - return JSON object for latest weather reading
http://<server>:<port>/weather/recent - return JSON object for most recent readings with (limited) analysis (raining)
http://<server>:<port>/weather/history - return JSON formatted full history on device

http://<server>:<port>/homepage/index.html - display a web page of data using KickStart and jQuery

### Requirements ###

KickStart - included but a notable mention
jQuery - referenced in UI components and awesome
node-hid npm - made solving the USB parts a lot easier (thank-you)
restify npm - makes the HTTP service elements so simple

### Installation ###

1. install nodejs
2. install npms (node-hid, restify)
3. Connect 1080 compatible Weather Station
4. Run node whid.js (may require sudo on Mac/Unix)

### Sourcing a Weather Station ###
In UK, Maplin stock at www.maplin.co.uk/p/black-usb-wireless-touchscreen-weather-forecaster-n96gy
