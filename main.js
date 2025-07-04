/**
 * Demo app using ArcGIS Location Platform and ArcGIS Maps SDK for JavaScript that demonstrates the following features:
 * Basemap select: navigation, imagery, custom
 * Data hosting with feature service: curated Palm Springs tourist attractions, popup; style points by unique value renderer
 * Route and directions between two selected points
 * show/hide traffic
 * show elevation at point
 * Places layer
 */
require([
    "esri/config",
    "esri/Basemap",
    "esri/Map",
    "esri/views/MapView",
    "esri/support/BasemapStyle",
    "esri/Graphic",
    "esri/rest/route",
    "esri/rest/support/RouteParameters",
    "esri/rest/support/FeatureSet",
    "esri/layers/FeatureLayer",
    "esri/layers/MapImageLayer",
    "esri/layers/VectorTileLayer",
    "esri/request",
    "esri/rest/places",
    "esri/rest/support/FetchPlaceParameters",
    "esri/rest/support/PlacesQueryParameters",
    "esri/geometry/Point",
    "esri/Graphic",
    "esri/layers/GraphicsLayer",
    "esri/geometry/geometryEngine",
    "esri/geometry/projection",
    "esri/geometry/SpatialReference",
    "esri/geometry/support/webMercatorUtils"
], function(esriConfig, Basemap, Map, MapView, BasemapStyle, Graphic, route, RouteParameters, FeatureSet, FeatureLayer, MapImageLayer, VectorTileLayer, esriRequest, places, FetchPlaceParameters, PlacesQueryParameters, Point, Graphic, GraphicsLayer, geometryEngine, projection, SpatialReference, webMercatorUtils) {
  setEventHandlers();
  let languageCode = "en";
  let initialViewPoint = [-117.1620642, 32.7060707]; // San Diego
  let worldView = "unitedStatesOfAmerica";
  let localizeCategories = true;
  let routingActive = false;
  let showElevation = false;
  let elevationMarkerLayer = null;
  let placesCategoriesList = null;
  let placesCategoriesToShow = null;
  let activePlaceCategory = "Restaurants";
  let processingPlaceSearch = false;
  let lastPlaceId = null;
  let chartWidget = null;
  let priorElevationMarker = null;
  const elevationMarkerSymbol = {
    type: "simple-marker",
    size: "10",
    color: "rgb(68, 169, 236)",
  };
  const routeLineSymbol = {
    type: "simple-line",
    color: "rgb(0, 87, 150)",
    width: "5px"
  };

  showElevationChart(false);
  updateConfigurationFromURL();
  esriConfig.apiKey = my_secret_api_key;
  const placesLayer = new GraphicsLayer({
    id: "placesLayer"
  });
  const initialBasemapId = document.getElementById("basemap-select").value;
  const map = new Map({
    basemap: basemapFromSelection(initialBasemapId),
    layers: [placesLayer]
  });
  const view = new MapView({
      container: "viewDiv",
      map: map,
      center: initialViewPoint,
      zoom: 11
  });

  view.when(function() {
    getPlacesCategoriesList(languageCode);
    showTouristAttractions(map);
    elevationMarkerLayer = new GraphicsLayer({ id: "marker-layer" })
    view.map.add(elevationMarkerLayer)
  })
  .catch(function(err) {
    console.error("MapView cannot be loaded: ", err);
  });

  view.on("click", function(event) {
    const mapPoint = event.mapPoint;
    if (routingActive) {
      if (view.graphics.length === 0) {
        addGraphic("origin", mapPoint);
      } else if (view.graphics.length === 1) {
        addGraphic("destination", mapPoint);
        getRoute();
      } else {
        view.graphics.removeAll();
        addGraphic("origin", mapPoint);
      }
    } else if (showElevation) {
      view.graphics.removeAll();
      getElevationDataAtPoint(view, mapPoint);
    } else {
      getPlacesNearby(activePlaceCategory, mapPoint);
    }
  });

  view.on("pointer-move", pointerMoveEventHandler);

  /**
   * Read the URL query string for any parameters to set up the application.
   */
  function updateConfigurationFromURL() {
    const queryParams = new URLSearchParams(location.search.substring(1));
    languageCode = queryParams.get("language") || "en";
    worldView = queryParams.get("worldview") || "unitedStatesOfAmerica";
  }

  /**
   * ---------------------------- Basemap -----------------------------------------
   * Reference: https://developers.arcgis.com/documentation/mapping-and-location-services/mapping/how-to-build-a-mapping-app/
   */
  const customBasemapItemId = "8a065cb78a5b4ebc9f56e314071249af";

  /**
   * Listen for a change event on the basemap picker UI.
   * @param {Event} event Event attributes.
   */
  function onChangeBasemap(event) {
    const comboBox = event.target;
    map.basemap = basemapFromSelection(comboBox.value);
  }

  /**
   * Create a new Basemap object based on the basemap selected in the UI.
   * @param {string} basemapId Which basemap was selected.
   * @returns {Basemap}
   */
  function basemapFromSelection(basemapId) {
    let basemap;
    switch (basemapId) {
      case "custom":
        basemap = new Basemap({
          baseLayers: [
            new VectorTileLayer({
              portalItem: {
                id: customBasemapItemId
              }
            })
          ]
        });
        break;
      case "imagery":
        basemap = new Basemap({
          style: new BasemapStyle({
            id: "arcgis/imagery",
            places: "attributed",
            worldview: worldView,
            language: languageCode
          })
        });
        break;
      case "navigation":
      default:
        basemap = new Basemap({
          style: new BasemapStyle({
            id: "arcgis/navigation",
            places: "attributed",
            worldview: worldView,
            language: languageCode
          })
        });
        break;
      }
      return basemap;
  }

  /**
   * Add a graphic symbol on the map indicating a reference point.
   * @param {string} type Modifier for the graphic, either "origin" or "destination".
   * @param {Point} point x, y where the point will appear on the map.
   */
  function addGraphic(type, point) {
    const graphic = new Graphic({
      symbol: {
        type: "simple-marker",
        color: (type === "origin") ? "white" : "black",
        size: "10px"
      },
      geometry: point
    });
    view.graphics.add(graphic);
  }

  /**
   * ---------------------------- Routing -----------------------------------------
   * Reference: https://developers.arcgis.com/documentation/mapping-and-location-services/routing-and-directions/how-to-build-a-routing-app/
   */
  const routeUrl = "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World";
  const trafficLayerURL = "https://traffic.arcgis.com/arcgis/rest/services/World/Traffic/MapServer";
  
  /**
   * Solve the route between the origin and destination points.
   */
  function getRoute() {
    const routeStops = new FeatureSet({
      features: view.graphics.toArray()
    });
    const routeParams = new RouteParameters({
      stops: routeStops,
      returnDirections: true,
      directionsOutputType: "complete"
    });

    route.solve(routeUrl, routeParams)
    .then(function(routeSolveResult) {

      if (routeSolveResult.routeResults.length > 0) {

        // show route geometry on map in a graphics layer
        const routeLayer = routeSolveResult.routeResults[0].route;
        const { attributes, geometry } = routeLayer;
        view.graphics.add(new Graphic({
          attributes,
          geometry,
          symbol: routeLineSymbol
        }));

        // Display turn-by-turn directions text
        const routeResult = routeSolveResult.routeResults[0].directions;
        const directions = document.createElement("ol");
        directions.classList = "esri-widget esri-widget--panel esri-directions__scroller";
        directions.style.marginTop = "50px";
        directions.style.padding = "12px 12px 12px 30px";
        const features = routeResult.features;

        features.forEach(function(result,i){
          const direction = document.createElement("li");
          direction.innerHTML = result.attributes.text + " (" + result.attributes.length.toFixed(2) + " miles)";
          directions.appendChild(direction);
        });

        // show summary of drive time and distance
        let summary = document.createElement("p");
        summary.innerText =
          "Distance: " + routeResult.totalLength.toFixed(2) +
          " miles; drive time: " + routeResult.totalDriveTime.toFixed(2) + " minutes";
        directions.appendChild(summary);
        view.ui.empty("top-right");
        view.ui.add(directions, "top-right");

        // if elevation switch is on then show the elevation chart.
        if (showElevation) {
          drawElevationChart(geometry);
        }
      }
    })
    .catch(function(error){
        console.log(error);
    });
  }

  /**
   * Traffic layer from Living Atlas uses map image tile layer, requires valid authentication.
   * @param {Map} map Map object to add traffic layer to.
   */
  function showTraffic(map) {
    let trafficLayer = map.findLayerById("traffic");
    if (trafficLayer) {
      trafficLayer.visible = true;
    } else {
      trafficLayer = new MapImageLayer({
        url: trafficLayerURL,
        id: "traffic",
        opacity: 0.6
      });
      map.layers.add(trafficLayer);
    }
  }

  function hideTraffic(map) {
    const trafficLayer = map.findLayerById("traffic");
    if (trafficLayer) {
      trafficLayer.visible = false;
    }
  }

  /**
   * Handle the route UI switch to enable or disable the routing service.
   */
  function onChangeRoute(event) {
    const element = event.target;
    routingActive = element.checked;
    if ( ! routingActive) {
      view.ui.empty("top-right");
      view.graphics.removeAll();
      showElevationChart(false);
    }
  }

  /**
   * Handle the UI switch to show or hide the traffic layer.
   */
  function onChangeTraffic(event) {
    const element = event.target;
    const isChecked = element.checked;
    if (isChecked) {
      showTraffic(map);
    } else {
      hideTraffic(map);
    }
  }

  /**
   * ----------------------- Data Hosting, Layers, Feature Services -----------------------------------------
   * Reference: https://developers.arcgis.com/documentation/portal-and-data-services/data-services/how-to-work-with-data-services/
   * Reference: https://developers.arcgis.com/documentation/mapping-and-location-services/mapping/data-layers/
   */
  const touristFeatureServiceURL = "https://services8.arcgis.com/PxLlS7hS3gd7MX6c/arcgis/rest/services/San_Diego_Tourist_Attractions/FeatureServer";
  const bikeRoutesURL = "https://services8.arcgis.com/PxLlS7hS3gd7MX6c/arcgis/rest/services/San_Diego_Bike_Routes/FeatureServer";
  const featureServiceURL = "https://services8.arcgis.com/PxLlS7hS3gd7MX6c/arcgis/rest/services/San_Diego_Bay_Run_20240715/FeatureServer";

  /**
   * Create a feature layer from our curated places data, add the unique value symbol
   * renderer with places icons, and add to the map.
   * @param {Map} map Map object to add the operational layer to.
   */
  function showTouristAttractions(map) {
    const otherSymbol = {
      type: "picture-marker",
      url: "https://static.arcgis.com/icons/places/Default_Building_48.png",
      width: "22px",
      height: "22px"
    };
    const museumSymbol = {
      type: "picture-marker",
      url: "https://static.arcgis.com/icons/places/Museum_48.png",
      width: "22px",
      height: "22px"
    };
    const parkSymbol = {
      type: "picture-marker",
      url: "https://static.arcgis.com/icons/places/Park_48.png",
      width: "22px",
      height: "22px"
    };
    const zooSymbol = {
      type: "picture-marker",
      url: "https://static.arcgis.com/icons/places/Zoo_48.png",
      width: "22px",
      height: "22px"
    };
    const trailSymbol = {
      type: "picture-marker",
      url: "https://static.arcgis.com/icons/places/National_Park_48.png",
      width: "22px",
      height: "22px"
    };
    const placesRenderer = {
      type: "unique-value",
      legendOptions: {
        title: "Place type",
      },
      defaultSymbol: otherSymbol,
      defaultLabel: "Other",
      field: "Category",
      uniqueValueInfos: [
        {
          value: "museum",
          symbol: museumSymbol,
          label: "Museum"
        },
        {
          value: "park",
          symbol: parkSymbol,
          label: "Park"
        },
        {
          value: "zoo",
          symbol: zooSymbol,
          label: "Zoo"
        },
        {
          value: "hiking trail",
          symbol: trailSymbol,
          label: "Hiking trail"
        }
      ],
    }
    const popupPlaces = {
      "title": "{Title}",
      "content": "<b>Type:</b> {Category}<br><b>Address:</b> {Address}<br><b>Website:</b> <a href=\"{URL}\">{URL}</a><br><b>Hours:</b> {hours}<br><b>Rating:</b> {rating}<p>{description}</p>"
    }

    const placesFeatureLayer = new FeatureLayer({
      url: touristFeatureServiceURL,
      outFields: ["*"],
      popupTemplate: popupPlaces,
      renderer: placesRenderer
    });
    map.add(placesFeatureLayer);
  }

  /**
   * Handle the UI switch to show or hide the bike route layer.
   */
  function onChangeBikeRoutes(event) {
    const element = event.target;
    const isChecked = element.checked;
    showBikeRoutes(map, isChecked);
  }

  function showBikeRoutes(map, visible) {
    let bikeRoutesFeatureLayer = map.findLayerById("bikeroutes");
    if (bikeRoutesFeatureLayer) {
      bikeRoutesFeatureLayer.visible = visible;
    } else if (visible) {
      bikeRoutesFeatureLayer = new FeatureLayer({
        url: bikeRoutesURL,
        id: "bikeroutes",
        opacity: 0.72
      });
      map.add(bikeRoutesFeatureLayer);
    }
  }

  /**
   * ---------------------------- Elevation -----------------------------------------
   * Reference: https://developers.arcgis.com/documentation/mapping-and-location-services/elevation/how-to-build-an-app-to-find-elevation/
   */
  const elevationURL = "https://elevation-api.arcgis.com/arcgis/rest/services/elevation-service/v1/elevation/";
  const elevationMeasure = "meanSeaLevel";

  /**
   * Query elevation data for the given single point and then render the UI
   * popup element to display the data.
   * @param {MapView} mapView Map view to add UI elements to.
   * @param {Point} mapPoint x, y where to query elevation data.
   */
  function getElevationDataAtPoint(mapView, mapPoint) {
    const longitude = mapPoint.longitude;
    const latitude = mapPoint.latitude;
    esriRequest(`${elevationURL}at-point`, {
      query: {
        lon: longitude,
        lat: latitude,
        relativeTo: elevationMeasure
      },
      responseType: "json",
    })
    .then(function(response) {
      const { x, y, z } = response.data.result.point;
      mapView.popup = {
        autoCloseEnabled: true,
        buttonEnabled: false,
        dockEnabled: true,
        visibleElements: {
          collapseButton: false,
          closeButton: true,
          actionBar: false,
        },
      };

      const title = `Relative to ${
        elevationMeasure === "meanSeaLevel"
          ? "mean sea level"
          : "ground level"
      }`;
      const content = `Elevation: ${z} m<br>Latitude: ${y.toFixed(5)}<br>Longitude: ${x.toFixed(5)}`;

      addGraphic("origin", mapPoint)
      mapView.openPopup({
        location: [longitude, latitude],
        content: content,
        title: title,
      });
    });
  }

  async function getElevationDataForPoints(coordinates) {
    const bodyJson = JSON.stringify({
      coordinates: coordinates,
      relativeTo: elevationMeasure,
    });
    const service_response = await fetch(
      `${elevationURL}at-many-points`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${esriConfig.apiKey}`,
        },
        body: bodyJson,
      }
    );
    let response = await service_response.json();
    return response["result"]["points"];
  }

  /**
   * Query for elevation data for element in the geometry. Works best if they are points.
   * @param {Array} geometry Array of points.
   */
  async function drawElevationChart(geometry) {
    if (geometry == null) {
      return;
    }
    showElevationChart(true);
    showChartLoader(true);
    const densifiedGeometry = await densifyGeometry(geometry);
    const wgs84Geometry = await projectGeometry(densifiedGeometry);
    const coordinatesArrays = await getCoordinatesArrays(wgs84Geometry);

    let meanSeaLevelRequests = [];

    coordinatesArrays.forEach(function(geographicPoints) {
      meanSeaLevelRequests.push(getElevationDataForPoints(geographicPoints));
    });

    const [meanSeaLevelResults] = await Promise.all([
      Promise.all(meanSeaLevelRequests),
    ]);

    let [meanSeaLevelData, totalDistance] = processPoints(
      meanSeaLevelResults,
      coordinatesArrays
    );

    updateElevationChart(meanSeaLevelData, totalDistance / 1000.0 + 0.1);
    showChartLoader(false);
  }

  /**
   * Handle the UI switch to enable or disable elevation query.
   */
  function onChangeElevation(event) {
    const element = event.target;
    showElevation = element.checked;
    if ( ! showElevation) {
      showElevationChart(false);
      view.graphics.removeAll();
      view.popup.close();
    }
  }

  /**
   * Show or hide the elevation chart div.
   * @param {boolean} visible 
   */
  function showElevationChart (visible) {
    const element = document.getElementById("chartDiv");
    element.style.display = visible ? "flex" : "none";
  }

  /**
   * Show or hide the elevation chart loading spinner.
   * @param {boolean} visible 
   */
  function showChartLoader (visible) {
    const element = document.getElementById("chartLoader")
    element.style.display = visible ? "block" : "none";
  }

  /**
   * Build the chart model from the elevation data.
   * @param {Array} meanSeaLevelData Array of the elevation data points to chart.
   * @param {Number} maxKm Max elevation value.
   */
  async function updateElevationChart(meanSeaLevelData, maxKm) {
    const elevationChart = document.getElementById("elevationLines");

    if (chartWidget != null) {
      chartWidget.destroy();
    }
    chartWidget = new Chart(elevationChart, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Mean Sea Level",
            data: meanSeaLevelData,
            parsing: {
              yAxisKey: "sea",
              xAxisKey: "distance",
            },
            tension: 0.1,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        tooltips: {
          enabled: true,
        },
        scales: {
          x: {
            type: "linear",
            min: 0,
            max: maxKm,
            title: {
              display: true,
              text: "Distance (km)",
            },
          },
          y: {
            display: true,
            title: {
              display: true,
              text: "Elevation (m)",
            },
          },
        },
        onHover: handleChartHover,
      },
    });
    chartWidget.update();
  }

  function handleChartHover (event, elements, chart) {
    if (elements.length === 0) {
      clearElevationMarker(); // Remove marker when hover is released
      return;
    }

    const datasetIndex = elements[0].datasetIndex;
    const index = elements[0].index;
    // const polylineIndex = chart.data.datasets[datasetIndex].data[index].polylineIndex;
    const { x, y } = chart.data.datasets[datasetIndex].data[index];
    showElevationMarker(x, y);
  }

  function clearElevationMarker() {
    if (priorElevationMarker) {
      elevationMarkerLayer.remove(priorElevationMarker);
      priorElevationMarker = null;
    }
  }

  const showElevationMarker = (longitude, latitude) => {
    clearElevationMarker();
    const elevationMarker = new Graphic({
      geometry: {
        type: "point",
        longitude: longitude,
        latitude: latitude,
      },
      symbol: elevationMarkerSymbol
    });
    elevationMarkerLayer.add(elevationMarker);
    priorElevationMarker = elevationMarker;
  }

  /**
   * ---------------------------- Places -----------------------------------------
   * Reference: https://developers.arcgis.com/documentation/mapping-and-location-services/place-finding/how-to-build-a-places-app/
   */
  const placesCategoriesURL = "https://places-api.arcgis.com/arcgis/rest/services/places-service/v1/categories";
  const placeQueryRadius = 500;

  /**
   * Pre-load all place categories in the requested language. Once loaded,
   * update the place category buttons with the new labels.
   */
  function getPlacesCategoriesList(language) {
    fetch(`${placesCategoriesURL}?icon=svg&language=${language}&token=${my_secret_api_key}`, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    })
    .then(function(response) {
      response.json().then(function(categoriesResponse) {
        placesCategoriesList = categoriesResponse.categories;
        showPlacesCategories(view);
      })
    });
  }

  /**
   * Show the places category buttons based on the curated set of places
   * we want to use in our app.
   * @param {MapView} mapView Parent of the display objects.
   */
  function showPlacesCategories(mapView) {
    if ( ! placesCategoriesToShow) {
      placesCategoriesToShow = [
        {
          name: "Default",
          isButton: false,
          categoryIds: "",
          icon: "https://static.arcgis.com/icons/places/Default_15.svg",
        },
        {
          name: "Restaurants",
          categoryIds: [
            "4d4b7105d754a06374d81259"
          ],
          labelCategoryId: "4d4b7105d754a06374d81259",
          isButton: true,
          isSelected: true,
          icon: "https://static.arcgis.com/icons/places/Restaurant_15.svg",
        },
        {
          name: "Bars/pubs",
          categoryIds: [
            "4bf58dd8d48988d117941735",
            "4bf58dd8d48988d118941735",
            "4bf58dd8d48988d1d5941735",
            "4bf58dd8d48988d11b941735",
            "5f2c224bb6d05514c70440a3",
            "4bf58dd8d48988d123941735",
            "50327c8591d4c4b30a586d5d",
            "5e189fd6eee47d000759bbfd",
            "52e81612bcbc57f1066b7a06"
          ],
          labelCategoryId: "4bf58dd8d48988d116941735",
          isButton: true,
          icon: "https://static.arcgis.com/icons/places/Bar_or_Pub_15.svg",
        },
        {
          name: "Grocery",
          categoryIds: [
            "4bf58dd8d48988d118951735",
            "52f2ab2ebcbc57f1066b8b45",
            "50aa9e744b90af0d42d5de0e",
            "52f2ab2ebcbc57f1066b8b2c",
            "5f2c41945b4c177b9a6dc7d6",
            "63be6904847c3692a84b9bf0"
          ],
          labelCategoryId: "4bf58dd8d48988d118951735",
          isButton: true,
          icon: "https://static.arcgis.com/icons/places/Grocery_Store_15.svg",
        },
        {
          name: "Coffee",
          categoryIds: [
            "4bf58dd8d48988d1e0931735",
            "5e18993feee47d000759b256"
          ],
          labelCategoryId: "4bf58dd8d48988d1e0931735",
          isButton: true,
          icon: "https://static.arcgis.com/icons/places/Coffee_or_Tea_15.svg",
        }
      ];
    }
    const categoryButtons = document.getElementById("categoryButtons");
    // Set up each category button to the categories we want to offer in the UI
    placesCategoriesToShow.forEach(function(placeType) {
      if ( ! placeType.isButton) {
        return;
      }
      const categoryButton = document.createElement("calcite-chip");
      categoryButton.classList.add("categoryButton");
      categoryButton.setAttribute("scale", "s");
      categoryButton.setAttribute("kind", "neutral");
      categoryButton.setAttribute("appearance", "solid");
      categoryButton.setAttribute("value", placeType.name);
      categoryButton.innerHTML = localizeCategories ? getCategoryNameLocalized(placeType.labelCategoryId) : placeType.name;
      if (placeType.isSelected) {
        categoryButton.setAttribute("selected", true);
        activePlaceCategory = getPlaceTypeByName(placeType.name);
      }
      categoryButton.addEventListener("calciteChipSelect", function(event) {
        if (processingPlaceSearch) {
          return;
        }
        clearPlaces();
        activePlaceCategory = getPlaceTypeByName(event.currentTarget.value);
      });

      const buttonAvatar = document.createElement("calcite-avatar");
      buttonAvatar.setAttribute("slot", "image");
      buttonAvatar.setAttribute("scale", "s");

      // add the icon
      const icon = getCategoryIconURL(placeType.categoryIds[0]);
      buttonAvatar.setAttribute("thumbnail", icon);
      categoryButton.append(buttonAvatar);
      categoryButtons.append(categoryButton);
    });
  }

  /**
   * Get places of the selected category near the point.
   */
  async function getPlacesNearby(placeCategory, mapPoint) {
    if (processingPlaceSearch) {
      return;
    }
    processingPlaceSearch = true;
    clearPlaces();
    const searchPoint = {
      type: "point",
      longitude: Math.round(mapPoint.longitude * 1000) / 1000,
      latitude: Math.round(mapPoint.latitude * 1000) / 1000
    }
    const placesQueryParameters = new PlacesQueryParameters({
      categoryIds: placeCategory.categoryIds,
      radius: placeQueryRadius,
      point: searchPoint,
      icon: "png"
    });
    places.queryPlacesNearPoint(placesQueryParameters)
    .then(async function(placesResults) {
      if (placesResults.results.length > 0) {
        placesResults.results.forEach(function(searchResult) {
          addPlaceMarker(searchResult);
        });
        // @todo: placesResults.nextQueryParams for more results
      }
      processingPlaceSearch = false;
    });
  }

  /**
   * Return the URL to the icon for the place category id. Requires the place
   * categories have been previously loaded.
   */
  function getCategoryIconURL(categoryId) {
    if ( ! placesCategoriesList) {
      return "https://static.arcgis.com/icons/places/Default_Arts_and_Entertainment_15.svg";
    }
    return placesCategoriesList.find(
      function(category) {
        return category.categoryId == categoryId;
      }
    ).icon.url;
  }

  /**
   * Return the name of a category id such that is can be localized from
   * the server response.
   */
  function getCategoryNameLocalized(categoryId) {
    if ( ! placesCategoriesList) {
      return "unknown";
    }
    const categoryNames = placesCategoriesList.find(
      function(category) {
        return category.categoryId == categoryId
      }
    ).fullLabel;
    return categoryNames[categoryNames.length - 1];
  }

  /**
   * Return the place type given its category name.
   * @param {string} name
   * @returns
   */
  function getPlaceTypeByName(categoryName) {
    return placesCategoriesToShow.find(placeType => placeType.name === categoryName)
  }

  /**
   * Remove any prior results/details from a prior place search.
   */
  function clearPlaces() {
    placesLayer.removeAll();
  }

  /**
   * Add a place result to the map in a graphics layer using the icon
   * based on the place category.
   * @param {Place} place Place result.
   */
  async function addPlaceMarker(placeAttributes) {
    const placeGraphic = new Graphic({
      geometry: {
        type: "point",
        y: placeAttributes.location.y,
        x: placeAttributes.location.x
      },
      symbol: {
        type: "picture-marker",
        url: placeAttributes.icon.url,
        width: 16,
        height: 16
      },
      attributes: placeAttributes
    });
    placesLayer.graphics.add(placeGraphic);
  }

  /**
   * Monitor the mouse movement over the map view so we can determine
   * when a place graphic is rolled-over and then show the attributes
   * about that place.
   * @param {Event} pointerEvent Event attributes.
   */
  async function pointerMoveEventHandler(pointerEvent) {
    const response = await view.hitTest(pointerEvent, {include: placesLayer});
    if (response.results.length > 0) {
      // hit something on the places layer, show the details
      const graphic = response.results[0].graphic;
      const placeAttributes = graphic.attributes;
      if (lastPlaceId != placeAttributes.placeId) {
        lastPlaceId = placeAttributes.placeId;
        getPlaceDetails(placeAttributes);
      }
    } else {
      // no results, clear any previous place detail
      lastPlaceId = null;
      if ( ! routingActive) {
        view.ui.empty("top-right");
      }
    }
  }

  /**
   * Get details about a place given its place ID returned from a place query.
   * @param {Place} placeAttributes Place attributes returned from a place query.
   */
  function getPlaceDetails(placeAttributes) {
    const fetchPlaceParameters = new FetchPlaceParameters({
      placeId: placeAttributes.placeId,
      requestedFields: ["all"],
    });
    places.fetchPlace(fetchPlaceParameters)
    .then(function(placeDetailsResult) {
      const placeDetails = placeDetailsResult.placeDetails;
      const details = document.createElement("div");
      details.classList = "esri-widget esri-widget--panel esri-directions__scroller";
      details.style.marginTop = "50px";
      details.style.padding = "12px 12px 12px 30px";

      // Take each place attribute and display in details panel
      function setAttribute(infoPanel, heading, icon, validValue) {
        if (validValue) {
          const element = document.createElement("calcite-block");
          element.heading = heading;
          element.description = validValue;
          const attributeIcon = document.createElement("calcite-icon");
          attributeIcon.icon = icon;
          attributeIcon.slot = "icon";
          attributeIcon.scale = "m";
          element.appendChild(attributeIcon);
          infoPanel.appendChild(element);
        }
      }

      details.innerHTML = `<h3>${placeDetails.name}</h3><p>${placeDetails.categories[0].label}</p>`;
      setAttribute(details, "Address", "map-pin", placeDetails.address.streetAddress);
      setAttribute(details, "Phone", "mobile", placeDetails.contactInfo.telephone);
      setAttribute(details, "Website", "web", placeDetails.contactInfo.website);
      setAttribute(details, "Email", "email-address", placeDetails.contactInfo.email);

      view.ui.empty("top-right");
      view.ui.add(details, "top-right");
    })
  }


      async function densifyGeometry(geometry) {
        const projectedGeometry = await projection.project(
          geometry,
          SpatialReference.WebMercator
        );
        const interval = 500;
        const densified = geometryEngine.densify(
          projectedGeometry,
          interval,
          "meters"
        );
        return densified;
      }

      async function generalizeGeometry(geometry) {
        const projectedGeometry = await projection.project(
          geometry,
          SpatialReference.WebMercator
        );
        const maxDeviation = 50;
        const generalized = geometryEngine.generalizeGeometry(
          projectedGeometry,
          maxDeviation
        );
        return generalized;
      }

      function processPoints(
        meanSeaLevelResults,
        coordinatesArrays
      ) {
        let meanSeaLevelData = []
        let totalDistance = 0

        for (let i = 0; i < meanSeaLevelResults.length; i++) {
          const meanSeaLevelPoints = meanSeaLevelResults[i]
          const coordinatesBatch = coordinatesArrays[i]

          meanSeaLevelPoints.forEach((point, index) => {
            if (index > 0) {
              const distance = calculateDistanceHaversine(
                meanSeaLevelPoints[index - 1],
                point,
                "meters"
              )
              totalDistance += distance

              meanSeaLevelData.push({
                sea: point.z,
                distance: totalDistance / 1000.0,
                polylineIndex: index,
                x: coordinatesBatch[index][0],
                y: coordinatesBatch[index][1],
              });
            }
          });
        }
        return [meanSeaLevelData, totalDistance]
      }

      function calculateDistanceHaversine(point1, point2) {
        const R = 6371e3 // Earth's radius in meters
        const lat1Radians = point1.y * (Math.PI / 180)
        const lat2Radians = point2.y * (Math.PI / 180)
        const deltaLatRadians = (point2.y - point1.y) * (Math.PI / 180)
        const deltaLonRadians = (point2.x - point1.x) * (Math.PI / 180)

        const a =
          Math.sin(deltaLatRadians / 2) * Math.sin(deltaLatRadians / 2) +
          Math.cos(lat1Radians) *
            Math.cos(lat2Radians) *
            Math.sin(deltaLonRadians / 2) *
            Math.sin(deltaLonRadians / 2)
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

        return R * c
      }

      async function projectGeometry(geometry) {
        const projected = await projection.project(
          geometry,
          SpatialReference.WGS84
        )
        return projected
      }

  async function getCoordinatesArrays(polyline) {
    const polylineJson = polyline.toJSON();
    const geometryPath = polylineJson.paths[0];

    let coordinatesArrays = [];
    let geographicPoints = [];
    geometryPath.forEach(function(coordinates) {
      if (geographicPoints.length < 100) {
        geographicPoints.push([coordinates[0], coordinates[1]])
      } else {
        coordinatesArrays.push(geographicPoints)
        geographicPoints = [[coordinates[0], coordinates[1]]]
      }
    });
    if (geographicPoints.length > 0) {
      coordinatesArrays.push(geographicPoints);
    }
    return coordinatesArrays;
  }


  /**
   * ---------------------------- Helpers -----------------------------------------
   * Supporting functions and UI helpers.
   */

  /**
   * Wire up the UI elements to event handlers.
   */
  function setEventHandlers() {
    let element = document.getElementById("basemap-select");
    if (element) {
      element.addEventListener("calciteComboboxChange", onChangeBasemap);
    }
    element = document.getElementById("traffic-switch");
    if (element) {
      element.addEventListener("calciteSwitchChange", onChangeTraffic);
    }
    element = document.getElementById("bike-switch");
    if (element) {
      element.addEventListener("calciteSwitchChange", onChangeBikeRoutes);
    }
    element = document.getElementById("route-switch");
    if (element) {
      element.addEventListener("calciteSwitchChange", onChangeRoute);
    }
    element = document.getElementById("elevation-switch");
    if (element) {
      element.addEventListener("calciteSwitchChange", onChangeElevation);
    }
  }
});
