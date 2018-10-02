'use strict';

window.DebugNS = '*';

// Dependencies
import IframeBridge from 'iframe-bridge';
import React from 'react';
import Visualizer from 'react-visualizer';
import { Tabs as BTabs, Tab, Button } from 'react-bootstrap';

// Components
import TabTitle from './TabTitle';
import Login from './Login';

// Other
import Tabs from '../main/Tabs';
import iframeMessageHandler from '../main/iframeMessageHandler';
import iframeBridge from '../main/iframe-bridge';
import tabStorage from '../main/tabStorage';
import { rewriteURL } from '../util';

const conf = require('../config/config.js');

// Setting this to true should load all the tabs on page load
// It is discouraged to do this because loading hidden iframes
// lead to layout issues. Especially in Firefox.
const loadHidden = conf.loadHidden || false;

const possibleViews = conf.possibleViews;
const forbiddenPossibleViews = Object.keys(possibleViews);

let tabInit = Promise.resolve();
let currentIframe;

const pageURL = new URL(window.location);
const pageQueryParameters = (function() {
  let params = {};
  for (let key of pageURL.searchParams.keys()) {
    params[key] = pageURL.searchParams.get(key);
  }
  return params;
})();

class App extends React.Component {
  constructor() {
    super();

    IframeBridge.registerHandler('tab', iframeMessageHandler);
    IframeBridge.registerHandler('admin', (data, [level2]) => {
      if (level2 === 'connect' && data.windowID !== undefined) {
        if (!currentIframe) {
          // The iframe was refreshed
          possibleViews[this.state.activeTabKey].windowID = data.windowID;
          this.sendData(this.state.activeTabKey);
        } else {
          possibleViews[currentIframe.id].windowID = data.windowID;
          currentIframe.resolve();
          currentIframe = null;
        }
      }
    });

    Tabs.on('openTab', obj => {
      const options = {};
      ['noFocus', 'noFocusEvent', 'noData', 'load'].forEach(prop => {
        options[prop] = obj[prop];
        delete obj[prop];
      });
      this.doTab(obj, options);
    });
    Tabs.on('status', this.setTabStatus.bind(this));
    Tabs.on('message', this.sendTabMessage.bind(this));
    Tabs.on('focus', this.focusTab.bind(this));

    this.visualizerVersion = pageURL.searchParams.get('v');

    this.state = {
      viewsList: [],
      activeTabKey: 0
    };

    this.loadTabs();
  }

  async loadTabs() {
    let firstTab;
    const loadTab = async view => {
      if (!firstTab) firstTab = view.id;
      await this.doTab(view, {
        noFocus: true,
        load: loadHidden,
        noFocusEvent: true
      });
    };
    const data = tabStorage.load();
    // Load possible views first
    for (let key in possibleViews) {
      possibleViews[key].id = key;
      let saved;
      if ((saved = data.find(el => el.id === key))) {
        await loadTab(saved);
      } else {
        await loadTab(possibleViews[key]);
      }
    }

    for (let i = 0; i < data.length; i++) {
      if (!possibleViews[data[i].id]) {
        await loadTab(data[i]);
      }
    }

    // Nothing is focused at this point
    const lastSelected = tabStorage.getSelected();
    if (this.state.viewsList.find(el => el.id === lastSelected)) {
      await this.showTab(lastSelected);
    } else {
      await this.showTab(firstTab);
    }
  }

  setTabStatus(data) {
    // Find view with given window ID
    const ids = Object.keys(possibleViews);
    let id = ids.find(id => possibleViews[id].windowID === data.windowID);
    if (!id) return;
    let view = possibleViews[id];

    view = this.state.viewsList.find(el => el.id === view.id);
    if (!view) return;

    view.status = Object.assign({}, view.status, data.message);
    this.setState({
      viewsList: this.state.viewsList
    });
  }

  sendTabMessage(data) {
    const viewInfo = possibleViews[data.id];
    if (viewInfo) {
      IframeBridge.postMessage('tab.message', data.message, viewInfo.windowID);
    }
  }

  async focusTab(tabId) {
    if (this.state.viewsList.find(el => el.id === tabId)) {
      await this.showTab(tabId, {
        noData: true
      });
    }
  }

  async doTab(obj, options) {
    if (!possibleViews[obj.id]) {
      possibleViews[obj.id] = {
        id: obj.id,
        url: obj.url,
        data: obj.data,
        closable: obj.closable
      };
    } else {
      possibleViews[obj.id].data = obj.data;
    }

    if (conf.rewriteRules) {
      let newURL = rewriteURL(conf.rewriteRules, possibleViews[obj.id].url);
      if (newURL) {
        possibleViews[obj.id].rewrittenUrl = newURL;
      }
    }

    await this.showTab(obj.id, options);
  }

  async showTab(id, options) {
    options = options || {};
    const sameTab = this.state.activeTabKey === id;
    if (sameTab && !options.force) return;

    const noFocus = options.noFocus;
    let viewFromList = this.state.viewsList.find(el => el.id === id);
    const newTab = !viewFromList;
    const viewInfo = possibleViews[id];

    if (!viewInfo) throw new Error('unreachable');
    if (!viewFromList) {
      viewFromList = {
        id: id,
        url: viewInfo.url,
        rewrittenUrl: viewInfo.rewrittenUrl,
        closable: viewInfo.closable
      };
      this.state.viewsList.push(viewFromList);
    }
    const firstRender =
      (options.load || !noFocus) && (newTab || !viewFromList.rendered);
    await tabInit;
    // First render means we expect the render function to initialize a new iframe
    // We need to get the IframeBridge ID of that frame and prevent any other iframes
    // to load during that time
    if (firstRender) {
      tabInit = new Promise(resolve => {
        viewFromList.rendered = true;
        this.setState({
          activeTabKey: options.noFocus ? undefined : id,
          viewsList: this.state.viewsList
        });

        setTimeout(() => {
          // This will have an effect only if Promise is not yet resolved
          // It prevents completely blocking the interface if there is a problem
          // with that tab
          return resolve();
        }, 3000);
        currentIframe = {
          resolve,
          id
        };
      });
      await tabInit;
    } else {
      this.setState({
        activeTabKey: noFocus ? undefined : id,
        viewsList: this.state.viewsList
      });
    }

    // always send data on first render
    if (!options.noData || firstRender) {
      this.sendData(id);
    }
    tabStorage.save(id, viewInfo);
    if (!options.noFocus) {
      tabStorage.saveSelected(id);
    }
    if (!options.noFocusEvent && !sameTab) {
      this.sendTabFocusEvent();
    }
  }

  sendData(id) {
    const viewInfo = possibleViews[id];
    IframeBridge.postMessage(
      'tab.data',
      Object.assign({}, viewInfo.data, {
        queryParameters: pageQueryParameters
      }),
      viewInfo.windowID
    );
  }

  async removeTab(id) {
    tabStorage.remove(id);
    if (forbiddenPossibleViews.indexOf(id) === -1) {
      delete possibleViews[id];
    }
    let idx = this.state.viewsList.findIndex(el => el.id === id);
    if (idx === -1) return;
    this.state.viewsList.splice(idx, 1);

    let newActiveTab;
    if (id !== this.state.activeTabKey) {
      newActiveTab = this.state.activeTabKey;
    } else {
      const viewsLength = this.state.viewsList.length;
      // Set next active tab
      if (viewsLength > 0) {
        if (idx < viewsLength) {
          newActiveTab = this.state.viewsList[idx].id;
        } else {
          newActiveTab = this.state.viewsList[viewsLength - 1].id;
        }
      }
    }

    await this.showTab(newActiveTab, {
      noData: true,
      force: true
    });
  }

  sendTabFocusEvent() {
    const key = this.state.activeTabKey;
    if (possibleViews[key]) {
      IframeBridge.postMessage('tab.focus', {}, possibleViews[key].windowID);
    }
  }

  async onActiveTab(key) {
    await this.showTab(key, {
      noData: true
    });
  }

  render() {
    const arr = [];

    for (let view of this.state.viewsList) {
      const closable = view.closable === undefined ? true : view.closable;
      const saved =
        !view.status || view.status.saved === undefined
          ? true
          : view.status.saved;

      const textStyle = {};
      if (!saved) {
        textStyle.color = 'red';
      }
      const shouldRender = view.rendered || view.id === this.state.activeTabKey;
      arr.push(
        <Tab
          title={
            <TabTitle
              textTitle={saved ? null : 'Not saved'}
              textStyle={textStyle}
              name={view.id}
              onTabClosed={closable ? this.removeTab.bind(this, view.id) : null}
            />
          }
          key={view.id}
          eventKey={view.id}
        >
          {shouldRender ? (
            <Visualizer
              fallbackVersion={conf.visualizerFallbackVersion || 'latest'}
              cdn={ conf.cdn || "https://www.lactame.com/visualizer" }
              viewURL={view.rewrittenUrl || view.url}
              version={
                this.visualizerVersion || conf.visualizerVersion || 'auto'
              }
              config={conf.visualizerConfig}
              scripts={[iframeBridge]}
              style={{ position: 'static', flex: 2, border: 'none' }}
            />
          ) : (
            <div>Not rendered</div>
          )}
        </Tab>
      );
    }

    return (
      <div className="visualizer-on-tabs-app">
        <Login />
        <div className="visualizer-on-tabs-content">
          <BTabs
            style={{ flex: 2, display: 'flex', flexFlow: 'column' }}
            activeKey={this.state.activeTabKey}
            onSelect={this.onActiveTab.bind(this)}
            animation={false}
          >
            {arr}
          </BTabs>
        </div>
      </div>
    );
  }
}

export default App;
