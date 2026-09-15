import Alpine from "alpinejs";
import * as d3 from "d3";
import * as math from "mathjs";
import { SHAKEN_ID, STIRRED_ID } from "./migrate.js";
import { cheapestOption, purchaseOptions, unitPrice } from "./sizes.js";
import { foldSizeIntoLoose, makeable, stockAmount } from "./bar.js";
import { conversionFactor, ingredientUnits, standardUnits } from "./units.js";

const chartCurrencyFormatDE = d3.formatDefaultLocale({
  thousands: '.',
  decimal: ',',
  grouping: [3],
  currency: ['', ' €'],
});

// `spaces` is the SpacesController of the open space. It is kept out of the
// returned object so that Alpine does not make the repo and hive reactive.
export function createStore(spaces = null) {
  return {
    data: {
      cocktails: [],
      ingredients: [],
      events: [],
      prepMethods: [
        {
          id: STIRRED_ID,
          name: 'stirred',
          dilutionFormula: '1 + (-1.21 * abv^2 + 1.246 * abv + 0.145)',
        },
        {
          id: SHAKEN_ID,
          name: 'shaken',
          dilutionFormula: '1 + (-1.567 * abv^2 + 1.742 * abv + 0.0203)',
        },
      ],
      glassTypes: [],
      // State of a permanent bar, keyed by the ids of cocktails and
      // ingredients. Only used in bar mode.
      bar: {
        cocktails: {},
        stock: {},
        par: {},
      },
      settings: {
        // 'popup' plans events, 'bar' runs a permanent bar with a menu.
        mode: 'popup',
        costDistRange: [50, 200],
        costDistMinimaNum: 5,
        costDistMinimaThreshold: 7,
        unitConvTable: [],
        darkMode: false,
      }
    },

    activeTab: 'null',

    // The open space and this device. Filled in by SpacesController.bind().
    space: {
      url: null,
      name: '',
      list: [],
      names: {},
      members: [],
      canAdmin: false,
      selfId: null,
      server: '',
      invite: null,
      busy: false,
      error: null,
      notice: null,
    },
    device: {
      name: '',
    },
    charts: {},
    barChart: null,
    revenueChart: null,

    // Utilities
    swap(array, index1, index2) {
      array[index1] = array.splice(index2, 1, array[index1])[0];
    },

    formatNumber(num) {
      const options = {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      };
      return (num).toLocaleString('de-DE', options);
    },

    formatCurrency(num) {
      const formatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
      return formatter.format(num);
    },

    formatURLinText(text) {
      // this isn't perfect, but good enough
      return text.replace(/(http|https):\/\/([\w+?\.\w+])+([a-zA-Z0-9\~\!\@\#\$\%\^\&\*\(\)_\-\=\+\\\/\?\.\:\;\'\,]*)?/g, (e) => '<a target="_blank" rel="noopener noreferrer" href="' + e + '">' + e + '</a>');
    },

    download(dataAttr, dataString, fileName) {
      var dataStr = dataAttr + dataString;
      var downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute('href',     dataStr);
      downloadAnchorNode.setAttribute('download', fileName);
      document.body.appendChild(downloadAnchorNode); // required for firefox
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    },

    exportShoppingListCSV(list) {
      let csv = '';
      const seperator = ';';
      const quot = '"';
      const formatText = (text) => {return text.replace('"', "'");};

      const head = ['Quant.', 'Unit size', '', 'Name', 'Unit Price' , 'Total Amount', '', '' , 'Cost', 'Source', 'Comment'];
      let body = [];

      list.sort((a, b) => a.shopLink?.localeCompare(b.shopLink) || -1).forEach((item) => {
        body.push([
          item.num,
          item.hasOwnProperty('size') ? item.size : '-',
          item.hasOwnProperty('unit') ? item.unit : '-',
          formatText(item.name),
          item.price !== 0 ? this.formatCurrency(item.price) : '-',
          item.hasOwnProperty('size') ? this.formatNumber(+item.num * +item.size) : '-',
          item.hasOwnProperty('amount') ? this.formatNumber(item.amount) : '-',
          item.hasOwnProperty('unit') ? item.unit : '-',
          this.formatCurrency(+item.num * +item.price),
          formatText(item.hasOwnProperty('shopLink') ? item.shopLink : '-'),
          formatText(item.hasOwnProperty('comment') ? item.comment : '')
        ]);
      });

      [head, ...body].forEach((row) => {
        csv += quot + row.join(quot + seperator + quot) + quot;
        csv += '\n'
      });

      this.download(
        'data:text/csv;charset=utf-8,',
        encodeURIComponent(csv),
        this.getEvent.name + '_shopping_list.csv'
      );
    },

    printElement(element_id, page='A4 portrait', zoom='100') {
      let css = document.styleSheets[0];
      let rule = css.insertRule(
        '@media print { \
          body > :not(#printarea) {display: none; } \
          @page { size: ' + page + ';} \
          body { zoom: ' + zoom + '%; } \
          .pill {display: none !important; } \
        }');

      document.documentElement.setAttribute('data-bs-theme', 'light');
      document.getElementById('printarea').innerHTML = document.getElementById(element_id).innerHTML;
      window.print();
      document.getElementById('printarea').innerHTML = '';
      document.documentElement.setAttribute('data-bs-theme', this.data.settings.darkMode ? 'dark' : 'light');

      css.deleteRule(rule);
    },

    collectPropFromIngredients(id, propName) {
      let item = this.data.cocktails.find((i) => i.id === id);
      if (item === undefined) {
        item = this.data.ingredients.find((i) => i.id === id);
      };
      if(item === undefined) {
        return [];
      };

      let collection = [];

      if (item.ingredients.length !== 0) {
        item.ingredients.forEach((i) => {
          const _ = this.collectPropFromIngredients(i.id, propName);
          if (Array.isArray(_)) {
            collection.push(..._);
          } else {
            collection.push(_);
          }  
        });
      };

      if (Array.isArray(item[propName])) {
        collection.push(...item[propName]);  
      } else {
        collection.push(item[propName]);
      }

      return collection;
    },

    // Persistence
    export() {
      const data = JSON.parse(JSON.stringify(this.data));
      data.events?.forEach((e) => delete e.barProgram?.recipes);
      this.download(
        'data:text/json;charset=utf-8,',
        encodeURIComponent(JSON.stringify(data, null, 2)),
        (this.space.name || 'barkeeper') + '.json'
      );
    },

    // Imports a file, either as a new space or replacing everything in the
    // open one.
    import(mode = 'new') {
      var fileInput = document.getElementById('import');
      fileInput.value = '';
      fileInput.click();

      fileInput.onchange = () => {
        const file = fileInput.files.item(0);
        var fr = new FileReader();
        fr.onload = (e) => {
          const data = JSON.parse(e.target.result);
          if (mode === 'replace') {
            if (!confirm('Replace everything in "' + this.space.name + '" with the contents of ' + file.name + '? This changes the space for every member.')) return;
            this.withBusy(() => spaces.replaceSpace(data));
            return;
          }
          const name = file.name.replace(/\.json$/i, '') || 'Imported bar';
          this.withBusy(() => spaces.importSpace(data, name));
        };
        fr.readAsText(file);
      };
    },

    // Spaces
    async withBusy(fn) {
      this.space.busy = true;
      this.space.error = null;
      this.space.notice = null;
      try {
        return await fn();
      } catch (error) {
        console.error(error);
        this.space.error = error?.message ?? String(error);
      } finally {
        this.space.busy = false;
      }
    },

    get otherSpaces() {
      return this.space.list.filter((s) => s.url !== this.space.url);
    },

    memberName(member) {
      if (member.isSyncServer) return 'Sync server';
      const name = this.space.names[member.id];
      if (name) return String(name) + (member.isSelf ? ' (you)' : '');
      return (member.isSelf ? 'You' : 'Unnamed') + ' · ' + member.id.slice(0, 8);
    },

    newSpace(name) {
      if (!name.trim()) return;
      this.withBusy(() => spaces.newSpace(name.trim()));
    },

    switchSpace(url) {
      this.withBusy(() => spaces.switchTo(url));
    },

    renameSpace(name) {
      spaces.rename(name);
    },

    leaveSpace(url) {
      if (!confirm('Forget this space on this device? Other members keep it, and you can join again with an invite link.')) return;
      spaces.leave(url);
    },

    createInvite(level) {
      this.space.invite = null;
      this.withBusy(async () => {
        this.space.invite = await spaces.createInvite(level);
      });
    },

    revokeMember(member) {
      if (!confirm('Remove ' + this.memberName(member) + ' from this space?')) return;
      this.withBusy(() => spaces.revoke(member.id));
    },

    setDeviceName(name) {
      this.device.name = name;
      spaces.setDeviceName(name);
    },

    saveServer(endpoint, contactCardJson, peerId) {
      if (!endpoint.trim() || !contactCardJson.trim() || !peerId.trim()) {
        this.space.error = 'A custom sync server needs its address, contact card and peer id.';
        return;
      }
      this.withBusy(() => spaces.setServer({
        endpoint: endpoint.trim(),
        contactCardJson: contactCardJson.trim(),
        peerId: peerId.trim(),
      }));
    },

    resetServer() {
      this.withBusy(() => spaces.setServer(null));
    },

    copyCocktailToSpace(id, url) {
      if (!url) return;
      this.withBusy(async () => {
        this.space.notice = await spaces.copyCocktailTo(id, url);
      });
    },

    copyIngredientToSpace(id, url) {
      if (!url) return;
      this.withBusy(async () => {
        this.space.notice = await spaces.copyIngredientTo(id, url);
      });
    },

    // Mode
    get barMode() {
      return this.data.settings.mode === 'bar';
    },

    get isCocktailTab() {
      if (this.barMode) return this.activeTab === 'Menu' || this.activeTab === 'Repertoire';
      return this.activeTab === 'null' || this.data.events.some((e) => e.id === this.activeTab);
    },

    get isEventTab() {
      return !this.barMode && this.data.events.some((e) => e.id === this.activeTab);
    },

    setMode(mode) {
      this.data.settings.mode = mode;
    },

    // Bar
    barEntry(collection, id) {
      return this.data.bar?.[collection]?.[id];
    },

    // Creates the entry if it does not exist yet. Only call from event handlers,
    // never while rendering.
    editBarEntry(collection, id) {
      this.data.bar ??= {};
      this.data.bar[collection] ??= {};
      this.data.bar[collection][id] ??= {};
      return this.data.bar[collection][id];
    },

    isOnMenu(id) {
      return this.barEntry('cocktails', id)?.onMenu === true;
    },

    setOnMenu(id, onMenu) {
      this.editBarEntry('cocktails', id).onMenu = onMenu;
    },

    // Stock, in the base unit of each ingredient. Undefined if not tracked.
    getStock(id) {
      return stockAmount(this.getIngredient(id), this.barEntry('stock', id));
    },

    isStockTracked(id) {
      return this.barEntry('stock', id) !== undefined;
    },

    getStockCount(id, sizeId) {
      return this.barEntry('stock', id)?.counts?.[sizeId];
    },

    // `value` comes from an input: an empty string clears the value, but does
    // not start tracking an ingredient that is not tracked yet.
    setStockCount(id, sizeId, value) {
      const clear = value === '' || !Number.isFinite(Number(value));
      if (clear && !this.isStockTracked(id)) return;
      const entry = this.editBarEntry('stock', id);
      entry.counts ??= {};
      if (clear) delete entry.counts[sizeId];
      else entry.counts[sizeId] = Number(value);
    },

    setStockLoose(id, value) {
      const clear = value === '' || !Number.isFinite(Number(value));
      if (clear && !this.isStockTracked(id)) return;
      const entry = this.editBarEntry('stock', id);
      if (clear) delete entry.loose;
      else entry.loose = Number(value);
    },

    stopTrackingStock(id) {
      if (this.data.bar?.stock) delete this.data.bar.stock[id];
    },

    // The minimum stock of an ingredient, in its base unit.
    getPar(id) {
      return this.data.bar?.par?.[id];
    },

    setPar(id, value) {
      this.data.bar ??= {};
      this.data.bar.par ??= {};
      if (value === '' || !Number.isFinite(Number(value))) delete this.data.bar.par[id];
      else this.data.bar.par[id] = Number(value);
    },

    // How many serves of a cocktail the stock allows, and the names of the
    // ingredients that run out first. The count is Infinity if nothing it
    // needs is tracked.
    getMakeable(id) {
      const cocktail = this.data.cocktails.find((c) => c.id === id);
      if (!cocktail) { return { count: Infinity, limiting: [] }; };
      const result = makeable(this.data, cocktail);
      return {
        count: result.count,
        limiting: result.limiting.map((i) => this.getIngredient(i)?.name ?? i),
      };
    },

    // Every cocktail, the ones on the menu first, with what the stock allows.
    get makeableCocktails() {
      return this.data.cocktails
        .map((c) => ({ id: c.id, name: c.name, onMenu: this.isOnMenu(c.id), ...this.getMakeable(c.id) }))
        .toSorted((a, b) => (b.onMenu - a.onMenu) || a.name.localeCompare(b.name));
    },

    // Ingredients for the stock list, by name.
    stockIngredients(searchString) {
      return this.searchIngredient(searchString).toSorted((a, b) => a.name.localeCompare(b.name));
    },

    // Events
    addEvent(name) {
      this.data.events.push({
        id: self.crypto.randomUUID(),
        name: name,
        barProgram: {
          ice: {
            cubeID: self.crypto.randomUUID(),
            cubeSize: 25,
            cubeBagWeight: 4,
            cubeBagCost: 0,
            crushedID: self.crypto.randomUUID(),
            scoopSize: 150,
            crushedBagWeight: 4,
            crushedBagCost: 0,
            largeCubeID: self.crypto.randomUUID(),
            largeCubeSize: 50,
            largeCubeCost: 0,
          },
          equipment: [],
          purchases: {},
          sources: {},
          cocktailsSold: []
        },
      });
    },

    get getEvent() {
      const id = this.activeTab;

      return this.data.events.find((e) => e.id === this.activeTab);
    },

    removeEvent(id) {
      this.data.events = this.data.events.filter((e) => e.id !== id);
      this.data.cocktails.forEach((c) => {
        if (c.event === id) { c.event = 'null' }
      });
    },

    // bar program
    get getNumCubes() {
      const id = this.activeTab;

      const cocktails = this.data.cocktails.filter((c) => c.event === id);
      if (!cocktails) {return 0};

      return cocktails.reduce((sum, c) => sum + (+c.cubes + +c.cubesServing)  * +c.numToPrep, 0 );
    },

    get getCubeWeight() {
      const event = this.getEvent;

      const numCubes = this.getNumCubes;
      const cubeSize = event.barProgram.ice.cubeSize;
      const density = 0.917;

      return numCubes*(cubeSize/10)**3*density/1000;
    },

    get getNumScoops() {
      const id = this.activeTab;

      const cocktails = this.data.cocktails.filter((c) => c.event === id);
      if (!cocktails) {return 0};

      return cocktails.reduce((sum, c) => sum + (+c.crushed + c.crushedServing) * +c.numToPrep, 0 );
    },

    get getCrushedWeight () {
      const event = this.getEvent;

      const numScoops = this.getNumScoops;
      const scoopSize = event.barProgram.ice.scoopSize;

      return numScoops*scoopSize/1000;
    },

    get getNumLargeCubes() {
      const id = this.activeTab;

      const cocktails = this.data.cocktails.filter((c) => c.event === id);
      if (!cocktails) {return 0};

      return cocktails.reduce((sum, c) => sum + (+c.largeCubes + +c.largeCubesServing) * +c.numToPrep, 0 );
    },

    get getLargeCubeWeight() {
      const event = this.getEvent;

      const numCubes = this.getNumLargeCubes;
      const cubeSize = event.barProgram.ice.largeCubeSize;
      const density = 0.917;

      return numCubes*(cubeSize/10)**3*density/1000;
    },

    // Prep Methods
    addPrepMethod(method_name) {
      this.data.prepMethods.push({
        id: self.crypto.randomUUID(),
        name: method_name,
        dilutionFormula: '1',
      });
    },

    removePrepMethod(method) {
      this.data.prepMethods = this.data.prepMethods.filter((e) => e.id !== method.id);
      this.data.cocktails.forEach((c) => {
        if (c.method === method.id) { c.method = '' }
      });
    },

    // Glass types
    removeGlassType(glass) {
      this.data.glassTypes = this.data.glassTypes.filter((e) => e !== glass);
      this.data.cocktails.forEach((c) => {
        if (c.glass === glass) { c.glass = '' }
      });
    },

    addGlassType(name) {
      this.data.glassTypes.push({
        id: self.crypto.randomUUID(),
        name: name,
        volume: 0
      });
    },

    // Ingredients
    addIngredient(name) {
      this.data.ingredients.unshift({
        id: self.crypto.randomUUID(),
        name: name,
        baseUnit: 'ml',
        units: [],
        ingredients: [],
        yield: 0,
        sizes: [],
        allergens: [],
        nonVeganIngredients: [],
        notes: '',
        safetyFactor: 0.1,
        abv: 0,
        color: '#e9ecef',
        hideInShoppingList: false
      });
    },

    removeIngredient(id) {
      this.data.ingredients = this.data.ingredients.filter((e) => e.id !== id);
      if (this.data.bar?.stock) delete this.data.bar.stock[id];
      if (this.data.bar?.par) delete this.data.bar.par[id];

      // remove refs from ingredients that have recipes
      this.data.ingredients.forEach((e) => {
        e.ingredients = e.ingredients.filter((i) => i.id !== id);
      });

      // remove refs from cocktails
      this.data.cocktails.forEach((e) => {
        e.ingredients = e.ingredients.filter((i) => i.id !== id);
      });
    },

    // Sizes and their sources
    addSize(ingredient) {
      ingredient.sizes.push({
        id: self.crypto.randomUUID(),
        size: 0,
        sources: [],
      });
    },

    removeSize(ingredient, sizeId) {
      const size = ingredient.sizes.find((s) => s.id === sizeId);
      const stock = this.barEntry('stock', ingredient.id);
      if (size && stock) foldSizeIntoLoose(stock, size);
      ingredient.sizes = ingredient.sizes.filter((s) => s.id !== sizeId);
    },

    addSource(size) {
      size.sources.push({
        id: self.crypto.randomUUID(),
        price: 0,
        shopLink: '',
      });
    },

    getPurchaseOptions(id) {
      return purchaseOptions(this.getIngredient(id));
    },

    searchIngredient(searchString, excludeIdsArray = []) {
      return this.data.ingredients
        .filter((e) => ! excludeIdsArray.includes(e.id))
        .filter((e) => e.name.toLowerCase().includes(searchString.toLowerCase()));
    },

    // return an array of allowed units for an ingredient (including the base unit)
    getIngredientAllowedUnits(id) {
      const i = this.getIngredient(id);
      const standardUnits = this.getIngredientStandardUnits(id).map(e => e[0]);

      // build array and deduplicate
      const uniqueUnits = [ ...new Set([...i.units.flatMap((e) => e[0]), ...standardUnits, i.baseUnit]) ];

      return uniqueUnits;
    },

    // return all global conversions from the global table that match
    getIngredientStandardUnits(id) {
      return standardUnits(this.getIngredient(id), this.data.settings.unitConvTable);
    },

    // return a full (standard and ingredient specific) units with conversion factors
    // if flag is set, don't deduplicate entries (usefull for finding out if an entry in the ingredient specific unit conversion table is valid)
    getIngredientUnits(id, dedupe = true) {
      return ingredientUnits(this.getIngredient(id), this.data.settings.unitConvTable, dedupe);
    },

    getIngredient(id) {
      return this.data.ingredients.find((e) => e.id === id);
    },

    // Cocktails
    removeCocktail(id) {
      this.data.cocktails = this.data.cocktails.filter((e) => e.id !== id);
      if (this.data.bar?.cocktails) delete this.data.bar.cocktails[id];
    },

    addCocktail(name, event = 'null') {
      const id = self.crypto.randomUUID();
      if (this.barMode) {
        event = 'null';
        if (this.activeTab === 'Menu') this.setOnMenu(id, true);
      }
      this.data.cocktails.unshift({
        id: id,
        name: name,
        ingredients: [],
        garnishes: [],
        notes: '',
        cubes: 0,
        crushed: 0,
        largeCubes: 0,
        cubesServing: 0,
        crushedServing: 0,
        largeCubesServing: 0,
        method: undefined,
        glass: undefined,
        event: event,
        numToPrep: 0,
        price: 0,
        flavorCues: [],
      });
    },

    copyCocktail(id, event = 'null') {
      const cocktail = this.data.cocktails.find((c) => c.id === id);
      if(!cocktail) { return 0; };

      // A deep copy, so that editing the copy does not change the original.
      const copy = JSON.parse(JSON.stringify(cocktail));
      const copyId = self.crypto.randomUUID();
      if (this.barMode) {
        event = cocktail.event;
        if (this.isOnMenu(id)) this.setOnMenu(copyId, true);
      }
      this.data.cocktails.unshift({
        ...copy,
        id: copyId,
        event: event,
      });
    },

    getGlassVolume(cocktail_id) {
      const cocktail = this.data.cocktails.find((c) => c.id === cocktail_id);
      if(!cocktail) { return 0; };

      const glass = this.data.glassTypes.find((g) => g.id === cocktail.glass);
      if(!glass) { return 0; };

      return glass.volume;
    },

    getCocktails(searchString = false) {
      let cocktails;
      if (this.barMode) {
        const onMenu = this.activeTab === 'Menu';
        cocktails = this.data.cocktails.filter((e) => this.isOnMenu(e.id) === onMenu);
      } else {
        cocktails = this.data.cocktails.filter((e) => e.event === this.activeTab);
      }

      if (searchString !== false) {
        return cocktails.filter((e) => e.name.toLowerCase().includes(searchString.toLowerCase()));
      };
      return cocktails;
    },

    getTags(id, type) {
      let item = this.data.cocktails.find((i) => i.id === id);
      if (item === undefined) {
        item = this.data.ingredients.find((i) => i.id === id);
      };
      if(item === undefined) {
        return [];
      };

      let tags = [];

      item.ingredients.forEach((i) => {
        tags.push(...this.collectPropFromIngredients(i.id, type));
      });

      item.garnishes?.forEach((i) => {
        tags.push(...this.collectPropFromIngredients(i.id, type));
      });

      return [...new Set(tags)];
    },

    getCocktailIngredientNames(cocktail_id) {
      const cocktail = this.data.cocktails.find((c) => c.id === cocktail_id);
      if(!cocktail) { return []; };

      const collectNames = (id) => {
        const ingredient = this.data.ingredients.find((i) => i.id === id);
        if (!ingredient) { return []; };

        let collection = [];

        if (ingredient.ingredients.length !== 0) {
          ingredient.ingredients.forEach((i) => {
            collection.push(...collectNames(i.id));
          });
        } else {
          collection.push(ingredient.name);
        }

        return collection;
      };

      let ingredients = [];

      cocktail.ingredients.forEach((i) => {
        ingredients.push(...collectNames(i.id));
      });

      return [...new Set(ingredients)];
    },

    getCocktailVolume(cocktail_id) {
      const cocktail = this.data.cocktails.find((c) => c.id === cocktail_id);
      if(!cocktail) { return 0; };

      let volume = 0;
      let ethanol = 0;

      cocktail.ingredients.forEach((ingredient) => {
        const baseUnit = this.getIngredient(ingredient.id).baseUnit;
        const abv = this.getIngredient(ingredient.id).abv/100;
        let conversionFactor = 1;
        let units = undefined;
        let unitConvTableEntry = undefined;

        // only consider ingredients which convert to ml, for now

        // if unit is in ml, just add, no conversion necessary
        if (ingredient.unit === 'ml') {
          volume += ingredient.amount;
          ethanol += ingredient.amount * abv;
          return;
        };

        // if ingredient has a base unit in ml, try to find a conversion entry
        if (baseUnit === 'ml') {
          units = this.getIngredientUnits(ingredient.id);
          unitConvTableEntry = units.find((e) => e[0] === ingredient.unit);

          if(unitConvTableEntry) {
            conversionFactor = unitConvTableEntry[1];
            volume += ingredient.amount * conversionFactor;
            ethanol += ingredient.amount * conversionFactor * abv;

            return;
          };
        };

        // last resort: check if there is a matching entry in the global conversion table
        units = [];

        this.data.settings.unitConvTable.forEach((entry) => {
          if (entry[0] === 'ml') { units.push([entry[1], 1/entry[2]]) };
          if (entry[1] === 'ml') { units.push([entry[0], entry[2]]) };
        });

        unitConvTableEntry = units.find((e) => e[0] === ingredient.unit);

        if(unitConvTableEntry) {
          conversionFactor = unitConvTableEntry[1];
          volume += ingredient.amount * conversionFactor;
          ethanol += ingredient.amount * conversionFactor * abv;
        };

      });

      return {volume: volume, ethanol: ethanol, volumeDiluted: this.getDilutedVolume(volume, ethanol, cocktail.method)};
    },

    // The ice of the open event, or the defaults of a new event where there is
    // none (the Ideas tab, bar mode).
    get iceSizes() {
      return this.getEvent?.barProgram.ice ?? { cubeSize: 25, scoopSize: 150, largeCubeSize: 50 };
    },

    getIceVolumePrep(cocktail_id) {
      const cocktail = this.data.cocktails.find((c) => c.id === cocktail_id);
      if(!cocktail) { return 0; };

      let volume = 0;

      // cubes
      const cubeSize = this.iceSizes.cubeSize;
      volume += cocktail.cubes * (cubeSize/10)**3;

      // large cubes
      const largeCubeSize = this.iceSizes.largeCubeSize;
      volume += cocktail.largeCubes * (largeCubeSize/10)**3;

      // crushed
      const scoopSize = this.iceSizes.scoopSize;
      const density = 0.917;
      volume += cocktail.crushed * scoopSize / density;

      return volume;
    },

    getIceVolumeServing(cocktail_id) {
      const cocktail = this.data.cocktails.find((c) => c.id === cocktail_id);
      if(!cocktail) { return 0; };

      let volume = 0;

      // cubes
      const cubeSize = this.iceSizes.cubeSize;
      volume += cocktail.cubesServing * (cubeSize/10)**3;

      // large cubes
      const largeCubeSize = this.iceSizes.largeCubeSize;
      volume += cocktail.largeCubesServing * (largeCubeSize/10)**3;

      // crushed
      const scoopSize = this.iceSizes.scoopSize;
      const density = 0.917;
      volume += cocktail.crushedServing * scoopSize / density;

      return volume;
    },

    getDilutedVolume(volume, ethanol, method_id) {
      const method = this.data.prepMethods.find((m) => m.id === method_id);
      if (!method) { return 0; };

      const abv = ethanol / volume;
      const f = math.parse(method.dilutionFormula);

      return volume * f.evaluate({abv: abv});
    },

    // accepts a recipe entry
    // and applys safetyFactor, unitConversion
    // and adjusts for yield if it's a recipe
    applyUnitConversion(recipe_entry) {
      let ingredient = this.getIngredient(recipe_entry.id);
      if (!ingredient) {return;};

      // Alpine.raw() only works on surface level, we need a deep copy here
      ingredient = JSON.parse(JSON.stringify(this.getIngredient(recipe_entry.id)));

      // convert amount to base unit and apply safety factor
      const factor         = conversionFactor(ingredient, recipe_entry.unit, this.data.settings.unitConvTable);
      let safetyFactor     = ingredient.safetyFactor;

      recipe_entry.color      = ingredient.color;
      recipe_entry.amount     = recipe_entry.amount * factor * (1 + +safetyFactor);
      recipe_entry.unit       = ingredient.baseUnit;
      recipe_entry.name       = ingredient.name;
      recipe_entry.notes      = ingredient.notes;

      // apply conversions to recipe
      if (ingredient.ingredients.length !== 0) {
        // jump one level up and adjust amounts for yield
        ingredient.ingredients.forEach((e, index) => {
          ingredient.ingredients[index].amount = (e.amount / ingredient.yield) * recipe_entry.amount;
        });
      };

      return { entry: recipe_entry, recipe: ingredient };
    },

    // flatten the recipe array, apply unit conversion and safety factor to make a shallow recipe
    assembleRecipe(recipe) {
      recipe.forEach((entry, index) => {
        const converted = this.applyUnitConversion(entry);
        if (!converted) { return; };

        let _recipe = converted.recipe;
        entry = converted.entry;

        // if _recipe contains ingredients (e.g. is a recipe)
        // recursivly call assembleRecipe 
        if (_recipe.ingredients.length !== 0) {
          // remove the recipe and insert ingredients
          _recipe.amount     = entry.amount;
          recipe[index] = this.assembleRecipe(_recipe.ingredients);

          // add info about the recipe
          recipe[index].recipe_info = {
            id:         entry.id,
            name:       this.getIngredient(entry.id).name,
            amount:     entry.amount,
            color:      entry.color,
            unit:       entry.unit,
            notes:      entry.notes,
          };
        };
      });
      return recipe;
    },

    // What one serve of a cocktail costs at the lowest price per ml (or piece)
    // of each ingredient, ignoring that bottles come in whole numbers.
    // `unpriced` lists the ingredients that have no source.
    calcServeCost(id) {
      const cocktail = this.data.cocktails.find((e) => e.id === id);
      if (!cocktail) { return { cost: 0, unpriced: [] }; };

      const ingredients = JSON.parse(JSON.stringify(cocktail.ingredients.concat(cocktail.garnishes)));
      const recipe = this.assembleRecipe(ingredients).flat(Infinity);

      let cost = 0;
      const unpriced = new Set();
      recipe.forEach((entry) => {
        const ingredient = this.getIngredient(entry.id);
        if (!ingredient) { return; };
        const price = unitPrice(ingredient);
        if (price === undefined) {
          unpriced.add(ingredient.name);
          return;
        };
        cost += entry.amount * price;
      });

      return { cost: cost, unpriced: [...unpriced] };
    },

    calcCocktailCost(id, min_n = false, max_n = false) {
      if (!min_n) { min_n = this.data.settings.costDistRange[0] };
      if (!max_n) { max_n = this.data.settings.costDistRange[1] };

      let cocktail = this.data.cocktails.find((e) => e.id === id);
      if (!cocktail) {return};

      let ingredients = JSON.parse(JSON.stringify(cocktail.ingredients.concat(cocktail.garnishes)));

      if (ingredients.length === 0) { return [['', 0]] };

      // build recipe
      let recipe = this.assembleRecipe(ingredients);

      // flatten, deduplicate and sum
      let summedRecipe = [];
      recipe = Object.groupBy(recipe.flat(Infinity), ({id}) => id);
      Object.entries(recipe).forEach((e) => {
        summedRecipe.push(
          {
            id:     e[0],
            unit:   e[1][0].unit,
            amount: e[1].reduce((acc, {amount}) => acc + +amount, 0),
          }
        );
      });

      // calculate costdistribution
      let costDistribution = [];
      for (var n = min_n; n <= max_n; n++) {
        let costSum = 0;

        summedRecipe.forEach((ingredient) => {
          const _ingredient = this.getIngredient(ingredient.id);
          if (!_ingredient) { return; };

          const costPerSource = [];
          purchaseOptions(_ingredient).forEach((source) => {
            costPerSource.push(Math.ceil((ingredient.amount*n)/source.size)*source.price);
          });
          costSum += Math.min(...costPerSource);
        });

        costDistribution.push([n, costSum/n || 0]);
      };

      return costDistribution;
    },

    // Charts
    createCocktailCostChart(container, dataset) {
      if (!dataset) {return};

      // reset
      container.innerHTML = '';

      // find largest y-value in dataset
      const digits = chartCurrencyFormatDE.format('$,.2f')(Math.max(...dataset.map((e) => e[1]))).length;

      // layout
      const width = container.offsetWidth;
      const height = container.offsetHeight;
      const margin = {
        top:    20,
        right:  20,
        bottom: 20,
        left:   digits*9
      };

      // data range
      const min_n = dataset[0][0];
      const max_n = dataset[dataset.length-1][0];

      // find min and max y (cost) value
      const max_cost = dataset.reduce((prev, cur) => (cur[1] > prev[1] ? cur : prev))[1] + +0.05;
      const min_cost = dataset.reduce((prev, cur) => (cur[1] < prev[1] ? cur : prev))[1] - +0.05;

      // find the lowest values to highlight

      // sort
      let dataset_sorted = dataset.toSorted((a, b) => a[1] - b[1]);
      let minima = [];
      const threshold = this.data.settings.costDistMinimaThreshold;
      const n = this.data.settings.costDistMinimaNum;

      // find local minima
      minima.push(dataset_sorted.shift());

      while (minima.length < n && dataset_sorted.length > 0) {
        const a = dataset_sorted.shift();

        if (minima.every((e) => Math.abs(e[0] - a[0]) > threshold)) {
          minima.push(a);
        };
      };

      // line generator
      const line = d3.line()
        .x(d => x(d[0]))
        .y(d => y(d[1]));

      // x (horizontal) scale
      const x = d3.scaleLinear()
          .domain([min_n, max_n])
          .range([margin.left, width - margin.right]);

      // y (vertical) scale
      const y = d3.scaleLinear()
          .domain([min_cost, max_cost])
          .range([height - margin.bottom, margin.top]);

      // create svg container
      //var svg = d3.create("svg")
      var svg = d3.select(container).append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox','0 0 ' + width + ' ' + height)
        .attr('preserveAspectRatio','xMinYMin');

      // add x-axis
      svg.append('g')
        .attr('class', 'axis')
        .attr('transform', 'translate(0,' + (height - margin.bottom) + ')')
        .call(d3.axisBottom(x));

      // add the y-axis, remove domain line, add grid lines
      svg.append('g')
        .attr('class', 'axis')
        .attr('transform', 'translate('+ margin.left + ',0)')
        .call(d3.axisLeft(y).tickFormat(chartCurrencyFormatDE.format('$,.2f')))
        .call(g => g.select('.domain').remove())
        .call(g => g.selectAll('.tick line').clone()
        .attr('x2', width - margin.left - margin.right)
        .attr('stroke-opacity', 0.3));

      // add data line
      svg.append('path')
        .attr('fill', 'none')
        .attr('stroke', 'steelblue')
        .attr('stroke-width', 2.5)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round')
        .attr('d', line(dataset));

      // add dots
      svg.selectAll('datadots')
        .data(dataset)
        .enter()
        .append('circle')
        .attr('fill', 'steelblue')
        .attr('r', 3.5)
        .attr('cx', d => x(d[0]))
        .attr('cy', d => y(d[1]));

      // highlight minima
      minima.forEach((m) => {
        svg.append("line")
          .attr("x1", x(m[0]))
          .attr("y1", margin.top)
          .attr("x2", x(m[0]))
          .attr("y2", height - margin.bottom)
          .style("stroke-width", 2)
          .style("stroke", "red")
          .style("fill", "none")
          .style("opacity", "0.5")
          .style("stroke-dasharray", ("3, 3"));
      });

      // tooltip
      const dot = svg.append('g')
        .attr('display', 'none');

      dot.append('circle')
        .attr('stroke', 'steelblue')
        .attr('r', 5);

      const text_x = width - margin.right*2;
      const text_y = margin.top*2;

      const box_w = 140;
      const box_h = 50;
      const box_margin = 20;

      const text = svg.append('text')
        .text('')
        .attr("fill", "currentColor")
        .attr("text-anchor", "end")
        .attr("class", "chart-tooltip")
        .attr('transform', 'translate(' + (text_x) + ',' + (text_y) + ')');

      var pointerenter = function() {
        dot.attr('display', null);
        text.attr('display', null);
      };

      var pointermove = function(event) {
        // find closest point on line to cursor
        const [xm, ym] = d3.pointer(event);
        const i = d3.leastIndex(dataset, ([_x, _y]) => Math.hypot(x(_x) - xm, 0));
        const [_x, _y] = dataset[i];

        dot.attr('transform', 'translate(' + x(_x) + ',' + y(_y) + ')');
        text.text(_x + ': ' + chartCurrencyFormatDE.format('$,.2f')(_y) );
        //svg.property('value', dataset[i]).dispatch('input', {bubbles: true});
      };

      var pointerleave = function() {
        dot.attr('display', 'none');
        text.attr('display', 'none');
        //svg.node().value = null;
        //svg.dispatch('input', {bubbles: true});
      };

      svg.on('pointerenter', pointerenter)
        .on('pointerleave', pointerleave)
        .on('pointermove', pointermove)
        .on('touchstart', (e) => {e.preventDefault()});

      //return svg.node();
    },

    createBarChart(container) {
      // palette
      const palette = [
        '8AC926',
        '823131',
        '457B9D'
      ];

      // reset
      container.innerHTML = '';

      // build dataset
      let dataset = [];
      let totals = {};
      let parts = [];
      [dataset, totals, parts] = this.finances;

      const max = Math.max(...dataset.map(e => e.Ingredients + e.Ice + e.Equipment), ...dataset.map(e => e.revenue));
      const digits = chartCurrencyFormatDE.format('$,.2f')(max).length;

      // layout
      const width = container.offsetWidth;
      const height = container.offsetHeight;
      const margin = {
        top:    20,
        right:  20,
        bottom: 60,
        left:   digits*9
      };

      // x scale
      const x = d3.scaleBand()
          .domain(dataset.map(e => e.name))
          .range([margin.left, width - margin.right])
          .padding([0.2]);

      // y scale
      const y = d3.scaleLinear()
          .domain([0, Math.ceil(max/100)*100 + 150])
          .range([height - margin.bottom, margin.top]);

      // create svg container
      //var svg = d3.create("svg")
      var svg = d3.select(container).append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox','0 0 ' + width + ' ' + height)
        .attr('preserveAspectRatio','xMinYMin');

      // add x-axis
      svg.append('g')
        .attr('class', 'axis')
        .attr('transform', 'translate(0,' + (height - margin.bottom) + ')')
        .style("font-size", "1rem")
        .call(d3.axisBottom(x).tickSizeOuter(0));

      // add the y-axis, remove domain line, add grid lines
      svg.append('g')
        .attr('class', 'axis')
        .attr('transform', 'translate('+ margin.left + ',0)')
        .call(d3.axisLeft(y).tickFormat(chartCurrencyFormatDE.format('$,.2f')))
        .call(g => g.select('.domain').remove())
        .call(g => g.selectAll('.tick line').clone()
        .attr('x2', width - margin.left - margin.right)
        .attr('stroke-opacity', 0.3));

      // color palette
      var color = d3.scaleOrdinal()
        .domain(parts)
        .range(palette);

      // stack
      var stackedData = d3.stack()
        .keys(parts)
        .order(d3.stackOrderNone)
        .offset(d3.stackOffsetNone)(dataset);

      // render bars
      svg.append("g")
        .selectAll("g")
        .data(stackedData)
        .enter().append("g")
          .attr("fill", (d) => { return '#' + color(d.key); })
          .selectAll("rect")
          .data((d) => { return d; })
          .enter().append("rect")
            .attr("x", (d) => { return x(d.data.name); })
            .attr("y", (d) => { return y(d[1]); })
            .attr("height", (d) => { return y(d[0]) - y(d[1]); })
            .attr("width",x.bandwidth());

      // render revenue lines and text
      dataset.forEach((c) => {
        svg.append("line")
          .attr("x1", x(c.name))
          .attr("y1", y(c.revenue))
          .attr("x2", x(c.name) + x.bandwidth())
          .attr("y2", y(c.revenue))
          .style("stroke-width", 2)
          .style("stroke-dasharray", "15, 5")
          .style("stroke", "currentColor")
          .style("fill", "none");

        svg.append('text')
          .text(chartCurrencyFormatDE.format('$,.2f')(c.revenue))
          .attr("fill", "currentColor")
          .attr("text-anchor", "middle")
          .attr("font-size", "1rem")
          .attr('transform', 'translate(' + (x(c.name) + x.bandwidth()/2) + ',' + (y(c.revenue) - 7) + ')');
      });
    },

    createRevenueChart(container) {
      // palette
      const palette = [
        '8AC926',
        '823131',
        '457B9D'
      ];

      // reset
      container.innerHTML = '';

      // build dataset
      let totals = {};
      let parts = [];
      let dataset = [];
      [dataset, totals, parts] = this.finances;

      const total_revenue  = dataset.reduce((acc, {revenue}) => acc + revenue, 0);
      const actual_revenue = this.getEvent.barProgram.cocktailsSold.reduce((acc, day) => acc + Object.entries(day).reduce((acc, [id, num]) => acc + num * (this.data.cocktails.find((i) => i.id === id)?.price ?? 0), 0), 0 );
      const total_expense  = Object.values(totals).reduce((acc, cur) => acc + cur, 0);
      const actual_expense = this.shoppingList.reduce((acc, item) => acc + this.getEvent.barProgram.purchases[item.id].expense, 0 );
      const max = Math.max(total_expense, total_revenue);
      const digits = chartCurrencyFormatDE.format('$,.2f')(max).length;

      // layout
      const width = container.offsetWidth;
      const height = container.offsetHeight;
      const margin = {
        top:     20,
        right:  100,
        bottom:  80,
        left:   100
      };
      const rangePadding = 0.2;

      // x scale
      const x = d3.scaleLinear()
          .domain([0, Math.ceil(max/100)*100])
          .range([margin.left, width - margin.right]);

      // y scale
      const y = d3.scaleBand()
          .domain(['_'])
          .range([margin.top, height - margin.bottom])
          .padding([rangePadding]);

      // create svg container
      //var svg = d3.create("svg")
      var svg = d3.select(container).append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox','0 0 ' + width + ' ' + height)
        .attr('preserveAspectRatio','xMinYMin');

      // add x-axis
      svg.append('g')
        .attr('class', 'axis')
        .attr('transform', 'translate(0,' + ( height - margin.bottom) + ')')
        .call(d3.axisBottom(x).tickFormat(chartCurrencyFormatDE.format('$,.2f')))
        .call(g => g.select('.domain').remove())
        .call(g => g.selectAll('.tick line').clone()
        .attr('y2', -height + margin.top + margin.bottom)
        .attr('stroke-opacity', 0.3));

      // add the y-axis, remove domain line, add grid lines
      svg.append('g')
        .attr('class', 'axis')
        .attr('transform', 'translate(' + (margin.left) + ', 0)')
        .call(d3.axisLeft(y).tickSizeOuter(0))
        .call(g => g.select('.domain').remove())
        .call(g => g.select('.tick').remove());

      // color palette
      var color = d3.scaleOrdinal()
        .domain(parts)
        .range(palette);

      // stack
      var stackedData = d3.stack()
        .keys(parts)
        .order(d3.stackOrderNone)
        .offset(d3.stackOffsetNone)([totals]);

      // render bars
      svg.append("g")
        .selectAll("g")
        .data(stackedData)
        .enter().append("g")
          .attr("fill", (d) => { return '#' + color(d.key); })
          .selectAll("rect")
          .data((d) => { return d; })
          .enter().append("rect")
            .attr("x", (d) => { return x(d[0]); })
            .attr("y", (d) => { return y('_'); })
            .attr("height",y.bandwidth())
            .attr("width", (d) => { return x(d[1]) - x(d[0]); });

      // render revenue and expense lines
      svg.append("line")
        .attr("x1", x(total_revenue))
        .attr("y1", y('_') + y.bandwidth()/2)
        .attr("x2", x(total_revenue))
        .attr("y2", y('_') + y.bandwidth())
        .style("stroke-width", 2)
        .style("stroke", "currentColor")
        .style("fill", "none");

      svg.append("line")
        .attr("x1", x(actual_revenue))
        .attr("y1", y('_') + y.bandwidth()/2)
        .attr("x2", x(actual_revenue))
        .attr("y2", y('_') + y.bandwidth())
        .style("stroke-width", 2)
        .style("stroke-dasharray", "5, 5")
        .style("stroke", "currentColor")
        .style("fill", "none");

      svg.append("line")
        .attr("x1", x(total_expense))
        .attr("y1", y('_'))
        .attr("x2", x(total_expense))
        .attr("y2", y('_') + y.bandwidth()/2)
        .style("stroke-width", 2)
        .style("stroke", "currentColor")
        .style("fill", "none");

      svg.append("line")
        .attr("x1", x(actual_expense))
        .attr("y1", y('_'))
        .attr("x2", x(actual_expense))
        .attr("y2", y('_') + y.bandwidth()/2)
        .style("stroke-width", 2)
        .style("stroke-dasharray", "5, 5")
        .style("stroke", "currentColor")
        .style("fill", "none");

      // render revenue and expense text
      svg.append('text')
        .text(chartCurrencyFormatDE.format('$,.2f')(total_revenue))
        .attr("fill", "green")
        .attr("text-anchor", "end")
        .attr("font-size", "1rem")
        .attr('transform', 'translate(' + x(total_revenue) + ',' + (y('_') + y.bandwidth() * (1 + rangePadding)) + ')');

      svg.append('text')
        .text(chartCurrencyFormatDE.format('$,.2f')(actual_revenue))
        .attr("fill", "green")
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "auto")
        .attr("font-size", "1rem")
        .attr('transform', 'translate(' + (x(actual_revenue) - 8) + ',' + (y('_') + y.bandwidth() * (1 - rangePadding)) + ')');

      svg.append('text')
        .text(chartCurrencyFormatDE.format('$,.2f')(total_expense))
        .attr("fill", "red")
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "hanging")
        .attr("font-size", "1rem")
        .attr('transform', 'translate(' + x(total_expense) + ',' + (y('_') - (y.bandwidth() * rangePadding)) + ')');

      svg.append('text')
        .text(chartCurrencyFormatDE.format('$,.2f')(actual_expense))
        .attr("fill", "red")
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "auto")
        .attr("font-size", "1rem")
        .attr('transform', 'translate(' + (x(actual_expense) - 8) + ',' + (y('_') + y.bandwidth()/4) + ')');

      // render legend
      var legend = svg.append('g')
        .attr('class', 'legend')
        .attr('transform', 'translate(' + (width/2 - (3*150)/2 + margin.left) + ', ' + (height - 40) + ')');

      legend.selectAll('rect')
        .data(parts)
        .enter()
        .append('rect')
        .attr('x', (d, i) => { return i * 150; })
        .attr('y', '0.8rem')
        .attr('width', 16)
        .attr('height', 16)
        .attr('fill', (d, i) => { return '#' + color(d); });

      legend.selectAll('text')
        .data(parts)
        .enter()
        .append('text')
        .text((d) => { return d; })
        .attr('x', (d, i) => { return i * 150 + 26; })
        .attr('y', 0)
        .attr('text-anchor', 'start')
        .attr('alignment-baseline', 'hanging')
        .attr('fill', "currentColor")
        .append('tspan')
        .text((d) => { return chartCurrencyFormatDE.format('$,.2f')(totals[d]); })
        .attr('x', (d, i) => { return i * 150 + 26; })
        .attr('y', "2.2rem");
    },

    assembleEventProgram(event_id) {
      let cocktails = this.data.cocktails.filter((e) => e.event === event_id);
      let recipes = {
        cocktails: {},
        recipes: [],
      };

      const collectRecipes = (recipe_list, recipe_collection, parent_index = null) => {
        recipe_list.forEach((item) => {
          if (!Array.isArray(item)) {
            recipe_collection[parent_index].ingredients.push({
              unit:       item.unit,
              amount:     item.amount,
              color:      item.color,
              id:         item.id,
              name:       item.name,
              type:       'ingredient',                  
            });
          } else {
            const recipe = {
              unit:       item.recipe_info.unit,
              amount:     item.recipe_info.amount,
              color:      item.recipe_info.color,
              id:         item.recipe_info.id,
              name:       item.recipe_info.name,
              notes:      item.recipe_info.notes,
              type:       'recipe',
              ingredients: [],
            };
            if (parent_index !== null) {
              recipe_collection[parent_index].ingredients.push({...recipe});
            }
            recipe_collection.push({...recipe});
            collectRecipes(item, recipe_collection, recipe_collection.length - 1);
          }
        });
      };

      cocktails.forEach((cocktail) => {
        recipes.cocktails[cocktail.id] = [];
        let c_recipes = [];
        let ingredients = JSON.parse(JSON.stringify(cocktail.ingredients.concat(cocktail.garnishes)));

        // build recipe
        let recipe = this.assembleRecipe(ingredients);

        recipe.forEach((item) => {
          if (!Array.isArray(item)) {
            recipes.cocktails[cocktail.id].push({
              unit:       item.unit,
              amount:     item.amount * cocktail.numToPrep,
              color:      item.color,
              id:         item.id,
              name:       item.name,
              type:       'ingredient',                  
            });
          } else {
            recipes.cocktails[cocktail.id].push({
              unit:       item.recipe_info.unit,
              amount:     item.recipe_info.amount * cocktail.numToPrep,
              color:      item.recipe_info.color,
              id:         item.recipe_info.id,
              name:       item.recipe_info.name,
              notes:      item.recipe_info.notes,
              type:       'recipe',
            });
          }
        });
        recipe = recipe.filter((item) => Array.isArray(item));            

        collectRecipes(recipe, c_recipes);
        // This creates a deep array, e. g. recipes in recipes contain a full list of their ingredients.
        // Workaround: delete the ingredient list when scaling the recipe.
        // TODO: let collectRecipes() create a flat array

        c_recipes.forEach((item) => {
          item.amount *= cocktail.numToPrep;

          item.ingredients.forEach((ingredient) => {
            ingredient.amount *= cocktail.numToPrep;
            if (ingredient.type === 'recipe') { delete ingredient.ingredients };
          });
        });

        recipes.recipes.push(...c_recipes);
      });

      // deduplicate and sum
      let summedRecipes = [];
      let _recipes = Object.values(Object.groupBy(recipes.recipes, ({id}) => id));
      _recipes.forEach((recipe) => {
        let summedRecipe = {
          unit:        recipe[0].unit,
          amount:      recipe.reduce((acc, {amount}) => acc + +amount, 0),
          color:       recipe[0].color,
          id:          recipe[0].id,
          name:        recipe[0].name,
          type:        recipe[0].type,
          notes:       recipe[0].notes,
          ingredients: recipe.reduce((acc, {ingredients}) => acc.concat(ingredients), []), 
        };

        let summedIngredients = [];
        let ingredients = Object.values(Object.groupBy(summedRecipe.ingredients, ({id}) => id));
        ingredients.forEach((ingredient) => {
          summedIngredients.push({
            unit:        ingredient[0].unit,
            amount:      ingredient.reduce((acc, {amount}) => acc + +amount, 0),
            color:       ingredient[0].color,
            id:          ingredient[0].id,
            name:        ingredient[0].name,
            type:        ingredient[0].type,
          });
        });
        summedRecipe.ingredients = summedIngredients;
        summedRecipes.push(summedRecipe);
      });
      recipes.recipes = summedRecipes;

      return recipes;
    },

    get finances() {
      const barProgram    = this.getEvent.barProgram;
      const shoppingList  = this.shoppingList;
      const cocktails     = Object.values(this.getCocktails());
      let dataset         = [];

      const parts = [
        'Ingredients',
        'Equipment',
        'Ice'
      ];

      if (cocktails.length === 0) { return []}

      cocktails.forEach((c) => {
        dataset.push({
          id:           c.id,
          name:         c.name,
          revenue:      c.numToPrep * c.price,
          Ingredients:  0
        });
      });

      // proportional equipment expense (distribute per amount)
      const num_cocktails = cocktails.reduce((acc, c) => {return acc + +c.numToPrep}, 0);
      const equipment_cost = barProgram.equipment.reduce((acc, e) => {return acc + (+e.num * +e.price)}, 0);

      cocktails.forEach((c) => {
        dataset.find((e) => e.id === c.id).Equipment = equipment_cost / num_cocktails * c.numToPrep;
      });

      // proportional ice expense (distribute by num cubes, crushed scoops and num of large cubes)
      const total_cubes       = this.getNumCubes;
      const total_scoops      = this.getNumScoops;
      const total_largeCubes  = this.getNumLargeCubes;

      const cube_item = shoppingList.find((i) => i.id === barProgram.ice.cubeID);
      let total_cubes_expense = 0;
      if (cube_item !== undefined) total_cubes_expense = +cube_item.num * +cube_item.price;

      const crushed_item = shoppingList.find((i) => i.id === barProgram.ice.crushedID);
      let total_scoops_expense = 0; 
      if (crushed_item !== undefined) total_scoops_expense = +crushed_item.num * +crushed_item.price;

      const largeCube_item = shoppingList.find((i) => i.id === barProgram.ice.largeCubeID);
      let total_largeCubes_expense = 0;
      if (largeCube_item !== undefined) total_largeCubes_expense = +largeCube_item.num * +largeCube_item.price;


      cocktails.forEach((c) => {
        // cubes
        let cube_expense = 0;
        if ( total_cubes !== 0 && ((+c.cubes + +c.cubesServing) * +c.numToPrep) !== 0 ) {
          cube_expense = total_cubes_expense / total_cubes * ((+c.cubes + +c.cubesServing) * +c.numToPrep);
        };

        // crushed
        let crushed_expense = 0;
        if ( total_scoops !== 0 && ((+c.crushed + +c.crushedServing) * +c.numToPrep) !== 0 ) {
          crushed_expense = total_scoops_expense / total_scoops * ((+c.crushed + +c.crushedServing) * +c.numToPrep);
        }

        // large cubes
        let largeCube_expense = 0;
        if ( total_largeCubes !== 0 && ((+c.largeCubes + c.largeCubesServing) * +c.numToPrep) !== 0 ) {
          largeCube_expense = total_largeCubes_expense / total_largeCubes * ((+c.largeCubes + c.largeCubesServing) * +c.numToPrep);
        }

        dataset.find((e) => e.id === c.id).Ice = cube_expense + crushed_expense + largeCube_expense;
      });


      // proportional ingredient expense (distriubte by amount)
      let recipes = {};
      let r_totals  = {};
      cocktails.forEach((c) => {
        let ingredients = JSON.parse(JSON.stringify(c.ingredients.concat(c.garnishes)));

        if (ingredients.length === 0) { 
          recipes[c.id] = [];
          return;
        };

        // build recipe
        let recipe = this.assembleRecipe(ingredients);

        // flatten, deduplicate and sum
        let summedRecipe = [];
        recipe = Object.groupBy(recipe.flat(Infinity), ({id}) => id);
        Object.entries(recipe).forEach((e) => {
          summedRecipe.push(
            {
              id:     e[0],
              unit:   e[1][0].unit,
              amount: e[1].reduce((acc, {amount}) => acc + +amount, 0) * c.numToPrep,
            }
          );
        });

        recipes[c.id] = summedRecipe;
      });

      Object.entries(recipes).forEach((e) => {
        e[1].forEach((i) => {
          if ( r_totals.hasOwnProperty(i.id) ) {
            r_totals[i.id] += +i.amount;
          } else {
            r_totals[i.id] = +i.amount;
          };
        });
      });

      cocktails.forEach((c) => {
        recipes[c.id].forEach((i) => {
          const item = shoppingList.find((item) => item.id === i.id);
          if (item === undefined) { return };

          dataset.find((e) => e.id === c.id).Ingredients += (+item.num * +item.price) / r_totals[i.id] * i.amount;
        });

      });

      const totals = {
        Ingredients: Object.values(dataset).reduce((acc, {Ingredients}) => {return acc + Ingredients }, 0),
        Equipment:   equipment_cost,
        Ice:         total_cubes_expense + total_scoops_expense + total_largeCubes_expense,
      };

      return [dataset, totals, parts];
    },

    get shoppingList () {
      if (this.getEvent === undefined) {return};

      let list = [];
      let barProgram = this.getEvent.barProgram;

      //
      // ingredients
      //
      let ingredients = [];
      Object.values(barProgram.recipes.cocktails).forEach((l) => {
        ingredients.push( ...l.filter( r => r.type !== 'recipe' ) );
      });

      barProgram.recipes.recipes.forEach((r) => {
        ingredients.push( ...r.ingredients.filter( e => e.type !== 'recipe' ) );
      });

      // dedupe and sum
      let summedIngredients = [];
      ingredients = Object.values(Object.groupBy(Alpine.raw(ingredients), ({id}) => id));

      ingredients.forEach((ingredient) => {
        let summedIngredient = { ...ingredient[0] };
        summedIngredient.amount = ingredient.reduce((acc, {amount}) => acc + +amount, 0);
        summedIngredients.push(summedIngredient);
      });
      ingredients = summedIngredients;

      ingredients.forEach((ingredient) => {
        const i = this.getIngredient(ingredient.id);
        if (i === undefined) { return };

        // use the source picked for this event, if there is none, the cheapest
        const source = barProgram.sources.hasOwnProperty(i.id)
          ? barProgram.sources[i.id]
          : cheapestOption(i, ingredient.amount) ?? {};

        ingredients.id      = i.id;
        ingredient.comment  = i.notes;
        ingredient.size     = source.size;
        ingredient.num      = Math.ceil((ingredient.amount)/source.size);
        ingredient.shopLink = source.shopLink;
        ingredient.price    = source.price;
        ingredient.hideInShoppingList  = i.hideInShoppingList;
      });

      list.push(...ingredients);

      //
      // equipment
      //
      list.push(...Alpine.raw(barProgram.equipment));

      //
      // ice
      //
      let ice = [
        {
          id:         barProgram.ice.cubeID,
          name:       'Ice cubes',
          comment:    barProgram.ice.cubeSize + ' mm cubes',
          size:       barProgram.ice.cubeBagWeight,
          unit:       'kg',
          num:        Math.ceil(this.getCubeWeight/barProgram.ice.cubeBagWeight),
          amount:     this.getCubeWeight,
          price:      barProgram.ice.cubeBagCost,
        },
        {
          id:         barProgram.ice.crushedID,
          name:       'Crushed ice',
          size:       barProgram.ice.crushedBagWeight,
          unit:       'kg',
          num:        Math.ceil(this.getCrushedWeight/barProgram.ice.crushedBagWeight),
          amount:     this.getCrushedWeight,
          price:      barProgram.ice.crushedBagCost,
        },
        {
          id:         barProgram.ice.largeCubeID,
          name:       'Big ice cubes',
          size:       1,
          comment:    this.formatNumber(barProgram.ice.largeCubeSize) + ' mm cubes',
          unit:       'pcs',
          num:        this.getNumLargeCubes,
          price:      barProgram.ice.largeCubeCost,
        }
      ];

      list.push(...ice.filter((e) => e.num !== 0));

      list.forEach((item) => {
        if (!this.getEvent.barProgram.purchases.hasOwnProperty(item.id) ) {
          this.getEvent.barProgram.purchases[item.id] = {
            comment: '',
            expense: 0,
            checked: false,
          };
        }
      });

      return list;
    },

    init() {
      // custom directives
      Alpine.directive(
        "destroy",
        (el, { expression }, { evaluateLater, cleanup }) => {
          const onDestroy = evaluateLater(expression);
          cleanup(onDestroy);
        }
      );

      Alpine.directive(
        "render",
        (el, { expression }, { evaluate }) => {
          evaluate(expression);
        }
      );

      // custom magics
      Alpine.magic(
        "isValidNumberNotZero",
        () => {
          return number => (isNaN(number) || number === 0 || number === null);
        }
      );

      Alpine.magic(
        "isValidNumber",
        () => {
          return number => (isNaN(number) || number === null);
        }
      );

      Alpine.magic(
        "formatNumber",
        () => {
          return number => (number).toLocaleString('de-DE', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        }
      );

      Alpine.magic(
        "formatCurrency",
        () => {
          const formatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
          return number => formatter.format(number);
        }
      );

      // bruteforce reactivity
      Alpine.effect(() => {
        // Sync to the space document
        spaces?.session?.touch(JSON.stringify(this.data));

        // update theme, which belongs to the device rather than the space
        localStorage.setItem('barkeeper-dark-mode', JSON.stringify(!!this.data.settings.darkMode));
        document.documentElement.setAttribute('data-bs-theme', this.data.settings.darkMode ? 'dark' : 'light');

        // Update bar programs
        this.data.events.forEach((e) => {
          e.barProgram['recipes'] = this.assembleEventProgram(e.id);
        });

        // update charts
        Object.entries(this.charts).forEach(( [id, el]) => {
          this.createCocktailCostChart(el, this.calcCocktailCost(id));
        });

        if(this.barChart) {
          this.createBarChart(this.barChart);
        };

        if(this.revenueChart) {
          this.createRevenueChart(this.revenueChart);
        };
      })
    },
  };
}
